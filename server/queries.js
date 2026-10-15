import { db } from './db.js';

const GAME_SELECT = `
  SELECT g.*,
         w.username AS white_name, w.rating AS white_rating, w.is_bot AS white_is_bot, w.bot_level AS white_bot_level,
         b.username AS black_name, b.rating AS black_rating, b.is_bot AS black_is_bot, b.bot_level AS black_bot_level,
         c.username AS creator_name,
         (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS move_count
  FROM games g
  LEFT JOIN users w ON w.id = g.white_id
  LEFT JOIN users b ON b.id = g.black_id
  JOIN users c ON c.id = g.creator_id
`;

const STATS_COLUMNS = `
  COUNT(g.id) AS played,
  COALESCE(SUM((g.result = 'white' AND g.white_id = u.id) OR (g.result = 'black' AND g.black_id = u.id)), 0) AS wins,
  COALESCE(SUM((g.result = 'white' AND g.black_id = u.id) OR (g.result = 'black' AND g.white_id = u.id)), 0) AS losses,
  COALESCE(SUM(g.result = 'draw'), 0) AS draws
`;

// Player stats and the leaderboard only count rated (human vs human) games.
const RATED_GAMES_JOIN = `
  LEFT JOIN games g ON g.status = 'finished' AND g.rated = 1 AND (g.white_id = u.id OR g.black_id = u.id)
`;

const stmts = {
  userById: db.prepare('SELECT id, username, rating, is_guest, is_bot, bot_level, created_at FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, is_guest) VALUES (?, ?, ?)'),
  userStats: db.prepare(`
    SELECT u.id, u.username, u.rating, u.is_guest AS isGuest, u.created_at, ${STATS_COLUMNS}
    FROM users u
    ${RATED_GAMES_JOIN}
    WHERE u.id = ?
    GROUP BY u.id
  `),
  leaderboard: db.prepare(`
    SELECT u.id, u.username, u.rating, ${STATS_COLUMNS}
    FROM users u
    ${RATED_GAMES_JOIN}
    WHERE u.is_guest = 0 AND u.is_bot = 0
    GROUP BY u.id
    ORDER BY u.rating DESC, wins DESC, u.username
    LIMIT 50
  `),
  botRecord: db.prepare(`
    SELECT bot.bot_level AS level,
           COALESCE(SUM((g.result = 'white' AND g.white_id = @id) OR (g.result = 'black' AND g.black_id = @id)), 0) AS wins,
           COALESCE(SUM((g.result = 'white' AND g.black_id = @id) OR (g.result = 'black' AND g.white_id = @id)), 0) AS losses,
           COALESCE(SUM(g.result = 'draw'), 0) AS draws
    FROM games g
    JOIN users bot ON bot.id = CASE WHEN g.white_id = @id THEN g.black_id ELSE g.white_id END
    WHERE g.status = 'finished' AND bot.is_bot = 1 AND (g.white_id = @id OR g.black_id = @id)
    GROUP BY bot.bot_level
  `),
  game: db.prepare(`${GAME_SELECT} WHERE g.id = ?`),
  openGames: db.prepare(`${GAME_SELECT} WHERE g.status = 'waiting' ORDER BY g.created_at DESC`),
  userGames: db.prepare(`
    ${GAME_SELECT}
    -- Games you played, plus bot matches you started (creator). Stopped matches are kept for replay.
    WHERE (g.white_id = @id OR g.black_id = @id OR g.creator_id = @id)
      AND (g.status IN ('active', 'finished')
           OR (g.status = 'cancelled' AND EXISTS (SELECT 1 FROM moves m WHERE m.game_id = g.id)))
    ORDER BY COALESCE(g.ended_at, g.started_at, g.created_at) DESC, g.id DESC
    LIMIT 200
  `),
  activeBotGames: db.prepare(`
    SELECT g.id FROM games g
    JOIN users w ON w.id = g.white_id
    JOIN users b ON b.id = g.black_id
    WHERE g.status = 'active' AND (w.is_bot = 1 OR b.is_bot = 1)
  `),
  moves: db.prepare('SELECT ply, san, uci, fen, played_at FROM moves WHERE game_id = ? ORDER BY ply'),
};

export const findUserById = (id) => stmts.userById.get(id);
export const findUserByName = (username) => stmts.userByName.get(username);
export const createUser = (username, hash, isGuest = false) =>
  stmts.insertUser.run(username, hash, isGuest ? 1 : 0).lastInsertRowid;
export const getUserStats = (id) => stmts.userStats.get(id);
export const getLeaderboard = () => stmts.leaderboard.all();
export const getBotRecord = (id) => stmts.botRecord.all({ id });
export const getGameRow = (id) => stmts.game.get(id);
export const getMoves = (gameId) => stmts.moves.all(gameId);
export const listOpenGames = () => stmts.openGames.all().map(serializeGame);
export const listUserGames = (id) => stmts.userGames.all({ id }).map(serializeGame);
export const listActiveBotGameIds = () => stmts.activeBotGames.all().map((r) => r.id);

function player(id, name, rating, ratingChange, isBot, botLevel) {
  return id ? { id, username: name, rating, ratingChange, isBot: !!isBot, botLevel } : null;
}

export function serializeGame(r) {
  return {
    id: r.id,
    status: r.status,
    result: r.result,
    reason: r.reason,
    rated: !!r.rated,
    fen: r.fen,
    pgn: r.pgn,
    moveCount: r.move_count,
    creator: { id: r.creator_id, username: r.creator_name },
    white: player(r.white_id, r.white_name, r.white_rating, r.white_rating_change, r.white_is_bot, r.white_bot_level),
    black: player(r.black_id, r.black_name, r.black_rating, r.black_rating_change, r.black_is_bot, r.black_bot_level),
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
