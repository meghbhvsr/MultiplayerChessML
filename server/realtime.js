import { WebSocketServer } from 'ws';
import { Chess } from 'chess.js';
import { db } from './db.js';
import { userFromToken } from './auth.js';
import { getGameRow, getMoves, serializeGame, listOpenGames, listActiveBotGameIds } from './queries.js';
import { seedBots, findBotByLevel, chooseBotMove } from './bots/index.js';

const START_FEN = new Chess().fen();
const SQUARE_RE = /^[a-h][1-8]$/;
const ELO_K = 32;

const clients = new Map();    // userId -> { username, sockets: Set<ws> }
const watchers = new Map();   // gameId -> Set<ws>
const engines = new Map();    // gameId -> Chess (cache of active games)
const drawOffers = new Map(); // gameId -> userId who offered
const botThinking = new Set(); // gameIds where a bot is computing its move
const BOT_MIN_THINK_MS = 400; // so instant engine replies don't feel jarring
// Bot vs bot matches: minimum time per move so people can follow along. Changeable while watching.
const MATCH_SPEEDS = { slow: 2000, normal: 800, fast: 100 };
const matchSpeed = new Map(); // gameId -> speed name (default 'normal')
const MAX_MATCHES_PER_USER = 3;

const sql = {
  insertGame: db.prepare(`INSERT INTO games (white_id, black_id, creator_id, status, fen) VALUES (?, ?, ?, 'waiting', ?)`),
  insertBotGame: db.prepare(`
    INSERT INTO games (white_id, black_id, creator_id, status, fen, rated, started_at)
    VALUES (?, ?, ?, 'active', ?, 0, datetime('now'))
  `),
  waitingByUser: db.prepare(`SELECT id FROM games WHERE creator_id = ? AND status = 'waiting'`),
  joinGame: db.prepare(`
    UPDATE games
    SET white_id = COALESCE(white_id, @uid), black_id = COALESCE(black_id, @uid),
        status = 'active', started_at = datetime('now')
    WHERE id = @id AND status = 'waiting' AND creator_id != @uid
  `),
  cancelGame: db.prepare(`UPDATE games SET status = 'cancelled', ended_at = datetime('now') WHERE id = ? AND status = 'waiting'`),
  stopMatch: db.prepare(`UPDATE games SET status = 'cancelled', ended_at = datetime('now') WHERE id = ? AND status = 'active'`),
  activeMatchesByUser: db.prepare(`
    SELECT COUNT(*) AS n FROM games g
    JOIN users w ON w.id = g.white_id
    JOIN users b ON b.id = g.black_id
    WHERE g.creator_id = ? AND g.status = 'active' AND w.is_bot = 1 AND b.is_bot = 1
  `),
  insertMove: db.prepare('INSERT INTO moves (game_id, ply, san, uci, fen) VALUES (?, ?, ?, ?, ?)'),
  updatePosition: db.prepare('UPDATE games SET fen = ?, pgn = ? WHERE id = ?'),
  finishGame: db.prepare(`
    UPDATE games
    SET status = 'finished', result = ?, reason = ?, ended_at = datetime('now'),
        white_rating_change = ?, black_rating_change = ?
    WHERE id = ? AND status = 'active'
  `),
  adjustRating: db.prepare('UPDATE users SET rating = rating + ? WHERE id = ?'),
};

// ---------- helpers ----------

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendToUser(userId, msg) {
  for (const ws of clients.get(userId)?.sockets ?? []) send(ws, msg);
}

function broadcastAll(msg) {
  for (const { sockets } of clients.values()) for (const ws of sockets) send(ws, msg);
}

const onlineUsers = () => [...clients.entries()].map(([id, c]) => ({ id, username: c.username }));
const broadcastLobby = () => broadcastAll({ type: 'lobby', openGames: listOpenGames() });
const broadcastOnline = () => broadcastAll({ type: 'online', users: onlineUsers() });

function engineFor(row) {
  let chess = engines.get(row.id);
  if (!chess) {
    chess = new Chess();
    for (const m of getMoves(row.id)) chess.move(m.san);
    chess.header('White', row.white_name ?? '?', 'Black', row.black_name ?? '?');
    engines.set(row.id, chess);
  }
  return chess;
}

function gameState(gameId) {
  const row = getGameRow(gameId);
  if (!row) return null;
  const moves = getMoves(gameId);
  const last = moves.at(-1);
  return {
    ...serializeGame(row),
    moves: moves.map((m) => m.san),
    lastMove: last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null,
    drawOfferFrom: drawOffers.get(gameId) ?? null,
    botThinking: botThinking.has(gameId),
    matchSpeed: matchSpeed.get(gameId) ?? 'normal',
  };
}

function broadcastGame(gameId) {
  const msg = { type: 'game_state', game: gameState(gameId) };
  for (const ws of watchers.get(gameId) ?? []) send(ws, msg);
}

class UserError extends Error {}

/** Loads an active game and confirms the user is playing in it. */
function requirePlayer(user, gameId) {
  const row = getGameRow(Number(gameId));
  if (!row) throw new UserError('Game not found');
  if (row.status !== 'active') throw new UserError('Game is not in progress');
  const color = row.white_id === user.id ? 'w' : row.black_id === user.id ? 'b' : null;
  if (!color) throw new UserError('You are not a player in this game');
  return { row, color };
}

const finishTx = db.transaction((row, result, reason) => {
  if (!row.rated) return sql.finishGame.run(result, reason, null, null, row.id).changes > 0;
  const expectedWhite = 1 / (1 + 10 ** ((row.black_rating - row.white_rating) / 400));
  const scoreWhite = result === 'white' ? 1 : result === 'black' ? 0 : 0.5;
  const whiteChange = Math.round(ELO_K * (scoreWhite - expectedWhite));
  const blackChange = -whiteChange;
  const { changes } = sql.finishGame.run(result, reason, whiteChange, blackChange, row.id);
  if (changes === 0) return false;
  sql.adjustRating.run(whiteChange, row.white_id);
  sql.adjustRating.run(blackChange, row.black_id);
  return true;
});

function finishGame(row, result, reason) {
  finishTx(row, result, reason);
  engines.delete(row.id);
  drawOffers.delete(row.id);
  matchSpeed.delete(row.id);
}

const recordMoveTx = db.transaction((gameId, chess, move) => {
  sql.insertMove.run(gameId, chess.history().length, move.san, move.from + move.to + (move.promotion ?? ''), chess.fen());
  sql.updatePosition.run(chess.fen(), chess.pgn(), gameId);
});

/** Plays a move for `color` ('w'/'b'), saves it, ends the game if it's over, and lets a bot reply. */
function applyMove(row, color, { from, to, promotion }) {
  const chess = engineFor(row);
  if (chess.turn() !== color) throw new UserError('It is not your turn');

  let move;
  try {
    move = chess.move({ from, to, promotion: ['q', 'r', 'b', 'n'].includes(promotion) ? promotion : 'q' });
  } catch {
    throw new UserError('Illegal move');
  }

  recordMoveTx(row.id, chess, move);
  drawOffers.delete(row.id);

  if (chess.isGameOver()) {
    const mover = color === 'w' ? 'white' : 'black';
    if (chess.isCheckmate()) finishGame(row, mover, 'checkmate');
    else if (chess.isStalemate()) finishGame(row, 'draw', 'stalemate');
    else if (chess.isInsufficientMaterial()) finishGame(row, 'draw', 'insufficient material');
    else if (chess.isThreefoldRepetition()) finishGame(row, 'draw', 'threefold repetition');
    else finishGame(row, 'draw', '50-move rule');
  }
  broadcastGame(row.id);
  scheduleBotMove(row.id);
}

/** Bot level of the side to move in an active game, or null if that side is a human. */
function botToMove(row) {
  if (row.status !== 'active') return null;
  const turn = engineFor(row).turn();
  return turn === 'w' ? (row.white_is_bot ? row.white_bot_level : null) : (row.black_is_bot ? row.black_bot_level : null);
}

/** If it's a bot's turn, computes and plays its move in the background. */
async function scheduleBotMove(gameId, attempt = 1) {
  if (botThinking.has(gameId)) return;
  const row = getGameRow(gameId);
  const level = row && botToMove(row);
  if (!level) return;

  const color = engineFor(row).turn();
  let thinking = true;
  botThinking.add(gameId);
  broadcastGame(gameId);
  try {
    const started = Date.now();
    const uci = await chooseBotMove(level, engineFor(row).fen());
    const isMatch = row.white_is_bot && row.black_is_bot;
    const minThink = isMatch ? MATCH_SPEEDS[matchSpeed.get(gameId) ?? 'normal'] : BOT_MIN_THINK_MS + Math.random() * 300;
    const wait = minThink - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    // The human may have resigned (or the game otherwise changed) while the bot was thinking.
    const fresh = getGameRow(gameId);
    if (fresh?.status !== 'active' || engineFor(fresh).turn() !== color) return;
    botThinking.delete(gameId);
    thinking = false;
    applyMove(fresh, color, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch (err) {
    console.error(`Bot move failed in game ${gameId} (attempt ${attempt}):`, err);
    // The engine pool replaces a crashed engine, so a retry usually succeeds.
    if (attempt < 3) setTimeout(() => scheduleBotMove(gameId, attempt + 1), 2000);
  } finally {
    if (thinking) {
      botThinking.delete(gameId);
      broadcastGame(gameId);
    }
  }
}

// ---------- message handlers ----------

const handlers = {
  create_game(ws, user, { color }) {
    if (sql.waitingByUser.get(user.id)) throw new UserError('You already have an open game waiting');
    const side = color === 'white' || color === 'black' ? color : Math.random() < 0.5 ? 'white' : 'black';
    const { lastInsertRowid: id } = sql.insertGame.run(
      side === 'white' ? user.id : null,
      side === 'black' ? user.id : null,
      user.id,
      START_FEN,
    );
    send(ws, { type: 'game_created', gameId: Number(id) });
    broadcastLobby();
  },

  join_game(ws, user, { gameId }) {
    const id = Number(gameId);
    const row = getGameRow(id);
    if (!row || row.status !== 'waiting') throw new UserError('That game is no longer available');
    if (row.creator_id === user.id) throw new UserError('You cannot join your own game');
    if (sql.joinGame.run({ id, uid: user.id }).changes === 0) throw new UserError('That game is no longer available');

    // A player who starts a game shouldn't keep a stale open seek in the lobby.
    const ownSeek = sql.waitingByUser.get(user.id);
    if (ownSeek) sql.cancelGame.run(ownSeek.id);

    const started = { type: 'game_started', gameId: id };
    sendToUser(row.creator_id, started);
    sendToUser(user.id, started);
    broadcastGame(id);
    broadcastLobby();
  },

  cancel_game(ws, user, { gameId }) {
    const row = getGameRow(Number(gameId));
    if (!row || row.creator_id !== user.id) throw new UserError('Game not found');
    if (row.status !== 'waiting') throw new UserError('Only games waiting for an opponent can be cancelled');
    sql.cancelGame.run(row.id);
    broadcastGame(row.id);
    broadcastLobby();
  },

  watch_game(ws, user, { gameId }) {
    const id = Number(gameId);
    const state = gameState(id);
    if (!state) throw new UserError('Game not found');
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(ws);
    ws.watching.add(id);
    send(ws, { type: 'game_state', game: state });
  },

  unwatch_game(ws, user, { gameId }) {
    const id = Number(gameId);
    watchers.get(id)?.delete(ws);
    ws.watching.delete(id);
  },

  move(ws, user, { gameId, from, to, promotion }) {
    const { row, color } = requirePlayer(user, gameId);
    if (!SQUARE_RE.test(from) || !SQUARE_RE.test(to)) throw new UserError('Invalid square');
    try {
      applyMove(row, color, { from, to, promotion });
    } catch (err) {
      send(ws, { type: 'game_state', game: gameState(row.id) }); // resync the client's board
      throw err;
    }
  },

  create_bot_game(ws, user, { level, color }) {
    const bot = findBotByLevel(Number(level));
    if (!bot) throw new UserError('Unknown computer level');
    const side = color === 'white' || color === 'black' ? color : Math.random() < 0.5 ? 'white' : 'black';
    const [whiteId, blackId] = side === 'white' ? [user.id, bot.id] : [bot.id, user.id];
    const id = Number(sql.insertBotGame.run(whiteId, blackId, user.id, START_FEN).lastInsertRowid);
    send(ws, { type: 'game_created', gameId: id });
    scheduleBotMove(id); // the bot opens if it's white
  },

  /** Two bots play each other while the user (and anyone with the link) watches. */
  create_bot_match(ws, user, { whiteLevel, blackLevel, speed }) {
    const white = findBotByLevel(Number(whiteLevel));
    const black = findBotByLevel(Number(blackLevel));
    if (!white || !black) throw new UserError('Unknown computer level');
    if (sql.activeMatchesByUser.get(user.id).n >= MAX_MATCHES_PER_USER) {
      throw new UserError(`You can run up to ${MAX_MATCHES_PER_USER} bot matches at once. Stop one first.`);
    }
    const id = Number(sql.insertBotGame.run(white.id, black.id, user.id, START_FEN).lastInsertRowid);
    if (MATCH_SPEEDS[speed]) matchSpeed.set(id, speed);
    send(ws, { type: 'game_created', gameId: id });
    scheduleBotMove(id);
  },

  set_match_speed(ws, user, { gameId, speed }) {
    const row = getGameRow(Number(gameId));
    if (!row || row.creator_id !== user.id || !(row.white_is_bot && row.black_is_bot)) throw new UserError('Match not found');
    if (!MATCH_SPEEDS[speed]) throw new UserError('Unknown speed');
    matchSpeed.set(row.id, speed);
    broadcastGame(row.id);
  },

  stop_match(ws, user, { gameId }) {
    const row = getGameRow(Number(gameId));
    if (!row || row.creator_id !== user.id || !(row.white_is_bot && row.black_is_bot)) throw new UserError('Match not found');
    sql.stopMatch.run(row.id); // a bot that's mid-thought sees the status change and doesn't move
    engines.delete(row.id);
    matchSpeed.delete(row.id);
    broadcastGame(row.id);
  },

  resign(ws, user, { gameId }) {
    const { row, color } = requirePlayer(user, gameId);
    finishGame(row, color === 'w' ? 'black' : 'white', 'resignation');
    broadcastGame(row.id);
  },

  offer_draw(ws, user, { gameId }) {
    const { row } = requirePlayer(user, gameId);
    if (row.white_is_bot || row.black_is_bot) throw new UserError('The computer never accepts draws. Play it out!');
    const existing = drawOffers.get(row.id);
    if (existing && existing !== user.id) {
      finishGame(row, 'draw', 'agreement'); // both sides offered: that's an agreement
    } else {
      drawOffers.set(row.id, user.id);
    }
    broadcastGame(row.id);
  },

  respond_draw(ws, user, { gameId, accept }) {
    const { row } = requirePlayer(user, gameId);
    const offeredBy = drawOffers.get(row.id);
    if (!offeredBy || offeredBy === user.id) throw new UserError('There is no draw offer to respond to');
    if (accept) finishGame(row, 'draw', 'agreement');
    else drawOffers.delete(row.id);
    broadcastGame(row.id);
  },

  chat(ws, user, { gameId, text }) {
    const id = Number(gameId);
    const body = String(text ?? '').trim().slice(0, 500);
    if (!body || !watchers.get(id)?.has(ws)) return;
    const msg = { type: 'chat', gameId: id, from: user.username, text: body, at: Date.now() };
    for (const w of watchers.get(id)) send(w, msg);
  },
};

// ---------- server ----------

export function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  seedBots();
  // Bot games interrupted by a server restart: let the bot make its pending move.
  for (const id of listActiveBotGameIds()) scheduleBotMove(id);

  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    const user = userFromToken(token);
    if (!user) return ws.close(4001, 'Unauthorized');

    ws.isAlive = true;
    ws.watching = new Set();
    ws.on('pong', () => { ws.isAlive = true; });

    if (!clients.has(user.id)) clients.set(user.id, { username: user.username, sockets: new Set() });
    clients.get(user.id).sockets.add(ws);

    send(ws, { type: 'hello', user: { id: user.id, username: user.username } });
    send(ws, { type: 'lobby', openGames: listOpenGames() });
    broadcastOnline();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const handler = handlers[msg?.type];
      if (!handler) return send(ws, { type: 'error', message: `Unknown message type: ${msg?.type}` });
      try {
        handler(ws, user, msg);
      } catch (err) {
        if (!(err instanceof UserError)) console.error(err);
        send(ws, { type: 'error', message: err instanceof UserError ? err.message : 'Server error' });
      }
    });

    ws.on('close', () => {
      for (const id of ws.watching) watchers.get(id)?.delete(ws);
      const entry = clients.get(user.id);
      entry?.sockets.delete(ws);
      if (entry && entry.sockets.size === 0) clients.delete(user.id);
      broadcastOnline();
    });
  });

  // Drop connections that stopped answering pings (closed laptop, lost wifi, ...).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));
}
