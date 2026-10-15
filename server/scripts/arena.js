/**
 * Arena: measures a bot's strength by playing it against Stockfish levels.
 *
 *   npm run arena                                  # NeuralNet Search vs Stockfish Lv4, 5, 6 — 16 games each
 *   npm run arena -- --bot 9 --vs 3,4,5            # NeuralNet Instinct instead
 *   npm run arena -- --vs 5,6,7 --games 24 --concurrency 4
 *
 * Each opening is played twice with colors swapped, so neither side gets a lucky opening. The result is a
 * performance rating with a 95% confidence range. Ratings are anchored to the Stockfish levels' estimated
 * ratings (server/bots/index.js), so the absolute number is approximate; comparing runs is what's reliable.
 *
 * For neural bots the measured rating is saved next to the model and shown in the app instead of "?".
 * Games are saved as PGN in server/arena/. Ctrl+C stops early and reports what was played.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const OPENINGS = [
  ['Ruy Lopez', 'e4 e5 Nf3 Nc6 Bb5 a6'],
  ['Italian Game', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['Sicilian Najdorf', 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'],
  ['Queen\'s Gambit Declined', 'd4 d5 c4 e6 Nc3 Nf6'],
  ['French Defense', 'e4 e6 d4 d5 Nc3 Nf6'],
  ['Caro-Kann', 'e4 c6 d4 d5 e5 Bf5'],
  ['King\'s Indian', 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6'],
  ['Slav Defense', 'd4 d5 c4 c6 Nf3 Nf6'],
  ['Nimzo-Indian', 'd4 Nf6 c4 e6 Nc3 Bb4'],
  ['English Opening', 'c4 e5 Nc3 Nf6 g3 d5'],
  ['Scandinavian', 'e4 d5 exd5 Qxd5 Nc3 Qa5'],
  ['Sicilian Alapin', 'e4 c5 c3 Nf6 e5 Nd5'],
  ['Petrov Defense', 'e4 e5 Nf3 Nf6 Nxe5 d6'],
  ['London System', 'd4 d5 Bf4 Nf6 e3 e6'],
  ['Dutch Defense', 'd4 f5 g3 Nf6 Bg2 e6'],
  ['Pirc Defense', 'e4 d6 d4 Nf6 Nc3 g6'],
].map(([name, moves]) => ({ name, moves: moves.split(' ') }));

function parseArgs(argv) {
  const args = { bot: 10, vs: [4, 5, 6], games: 16, concurrency: 3, maxPlies: 300, save: true };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--bot') args.bot = Number(value), i++;
    else if (key === '--vs') args.vs = value.split(',').map(Number), i++;
    else if (key === '--games') args.games = Number(value), i++;
    else if (key === '--concurrency') args.concurrency = Number(value), i++;
    else if (key === '--max-plies') args.maxPlies = Number(value), i++;
    else if (key === '--no-save') args.save = false;
    else if (key === '--help' || key === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`Unknown option ${key} (see --help)`);
  }
  if (args.games % 2) args.games++; // games come in color-swapped pairs
  return args;
}

const args = parseArgs(process.argv.slice(2));

// The arena doesn't touch the real database, and needs one Stockfish engine per concurrent game.
process.env.DB_PATH = ':memory:';
process.env.BOT_ENGINES = String(args.concurrency);
const { BOT_LEVELS, botUsername, chooseBotMove } = await import('../bots/index.js');
const { neuralModelAvailable, saveMeasuredRating } = await import('../bots/neural.js');
const { shutdownEngines } = await import('../bots/stockfish.js');

const config = (level) => {
  const c = BOT_LEVELS.find((b) => b.level === level);
  if (!c) throw new Error(`Unknown bot level ${level}`);
  return c;
};
const candidate = config(args.bot);
const opponents = args.vs.map(config);
if (candidate.engine === 'neural' && !neuralModelAvailable()) {
  console.error('No trained model found (server/models/chessnet.onnx). Export one with ml/export_onnx.py first.');
  process.exit(1);
}
if (opponents.some((o) => o.engine !== 'stockfish')) {
  console.error('Opponents must be Stockfish levels (1-8): their ratings are the reference point.');
  process.exit(1);
}

// ---------- playing games ----------

async function playGame({ white, black, opening }) {
  const chess = new Chess();
  for (const san of opening.moves) chess.move(san);
  while (!chess.isGameOver() && chess.history().length < args.maxPlies) {
    const level = chess.turn() === 'w' ? white : black;
    const uci = await chooseBotMove(level, chess.fen());
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }

  let result, reason;
  if (chess.isCheckmate()) [result, reason] = [chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate'];
  else if (chess.isStalemate()) [result, reason] = ['1/2-1/2', 'stalemate'];
  else if (chess.isInsufficientMaterial()) [result, reason] = ['1/2-1/2', 'insufficient material'];
  else if (chess.isThreefoldRepetition()) [result, reason] = ['1/2-1/2', 'threefold repetition'];
  else if (chess.isDraw()) [result, reason] = ['1/2-1/2', '50-move rule'];
  else [result, reason] = ['1/2-1/2', `adjudicated draw after ${args.maxPlies} plies`];

  chess.header('Event', 'Arena', 'White', botUsername(white), 'Black', botUsername(black), 'Opening', opening.name, 'Result', result);
  return { result, reason, plies: chess.history().length, pgn: chess.pgn() };
}

// ---------- rating maths ----------

const expected = (rating, oppRating) => 1 / (1 + 10 ** ((oppRating - rating) / 400));

/** The rating at which the expected score against these opponents equals `score` (bisection). */
function performance(games, score) {
  const n = games.length;
  const target = Math.min(Math.max(score, 0.25), n - 0.25); // a perfect score has no finite rating
  let lo = -1000;
  let hi = 4500;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const total = games.reduce((sum, g) => sum + expected(mid, g.oppRating), 0);
    if (total < target) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

function summarize(games) {
  const n = games.length;
  const score = games.reduce((s, g) => s + g.score, 0);
  const mean = score / n;
  let variance = n > 1 ? games.reduce((s, g) => s + (g.score - mean) ** 2, 0) / (n - 1) : 0.25;
  if (variance === 0) {
    // All wins / all losses / all draws: the sample has no spread, but the true result still has some.
    const p = (score + 1) / (n + 2);
    variance = p * (1 - p);
  }
  const margin = 1.96 * Math.sqrt(variance / n) * n; // 95% interval on the total score
  return {
    games: n,
    score,
    rating: performance(games, score),
    low: performance(games, score - margin),
    high: performance(games, score + margin),
  };
}

// ---------- run ----------

const schedule = [];
for (const opp of opponents) {
  for (let i = 0; i < args.games / 2; i++) {
    const opening = OPENINGS[i % OPENINGS.length];
    schedule.push({ white: candidate.level, black: opp.level, opening, opp });
    schedule.push({ white: opp.level, black: candidate.level, opening, opp });
  }
}

const name = botUsername(candidate.level);
console.log(`Arena: ${name} vs ${opponents.map((o) => `${botUsername(o.level)} (≈${o.rating})`).join(', ')}`);
console.log(`${schedule.length} games, ${args.concurrency} at a time. Ctrl+C to stop early.\n`);

const finished = [];
let interrupted = false;
process.removeAllListeners('SIGINT'); // the engine pool exits on SIGINT; we want to report first
process.on('SIGINT', () => {
  if (interrupted) process.exit(1);
  interrupted = true;
  console.log('\nStopping after the games in progress… (Ctrl+C again to quit immediately)');
});

const started = Date.now();
let next = 0;
async function worker() {
  while (next < schedule.length && !interrupted) {
    const game = schedule[next++];
    const t0 = Date.now();
    const { result, reason, plies, pgn } = await playGame(game);
    const candidateWhite = game.white === candidate.level;
    const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === candidateWhite ? 1 : 0;
    finished.push({ ...game, result, reason, plies, pgn, score, oppRating: game.opp.rating });
    const label = ['loss', 'draw', 'win'][score * 2];
    console.log(
      `${String(finished.length).padStart(3)}/${schedule.length}  ${label.padEnd(4)}  ` +
        `${botUsername(game.white)} vs ${botUsername(game.black)}  ${result}  ${reason}, ` +
        `${Math.ceil(plies / 2)} moves, ${Math.round((Date.now() - t0) / 1000)}s  [${game.opening.name}]`,
    );
  }
}
await Promise.all(Array.from({ length: args.concurrency }, worker));
shutdownEngines();

if (!finished.length) process.exit(1);

// ---------- report ----------

console.log(`\nResults for ${name} (${Math.round((Date.now() - started) / 60000)} min):\n`);
console.log(`  ${'Opponent'.padEnd(22)}  W   D   L   Score   Performance`);
for (const opp of opponents) {
  const games = finished.filter((g) => g.opp.level === opp.level);
  if (!games.length) continue;
  const count = (s) => games.filter((g) => g.score === s).length;
  const s = summarize(games);
  console.log(
    `  ${`${botUsername(opp.level)} (≈${opp.rating})`.padEnd(22)}${String(count(1)).padStart(3)}${String(count(0.5)).padStart(4)}` +
      `${String(count(0)).padStart(4)}   ${`${((s.score / s.games) * 100).toFixed(0)}%`.padStart(4)}    ${s.rating}`,
  );
}
const overall = summarize(finished);
console.log(`\n  Estimated rating: ${overall.rating}  (95% range ${overall.low}–${overall.high}, ${overall.games} games)`);
if (overall.score === overall.games) {
  console.log(`  It won every game, so it's at least this strong. Add stronger opponents (e.g. --vs ${Math.max(...args.vs) + 1},${Math.max(...args.vs) + 2}).`);
} else if (overall.score === 0) {
  console.log(`  It lost every game, so it's at most this strong. Try weaker opponents (e.g. --vs ${Math.max(1, Math.min(...args.vs) - 2)},${Math.max(1, Math.min(...args.vs) - 1)}).`);
}
console.log('  Anchored to the Stockfish levels\' estimated ratings, so treat it as approximate;');
console.log('  comparing two runs of this script is reliable. More games = narrower range.');

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'arena');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const pgnPath = path.join(outDir, `${stamp}-${name.replace(/\s+/g, '_')}.pgn`);
fs.writeFileSync(pgnPath, finished.map((g) => g.pgn).join('\n\n') + '\n');
console.log(`\n  Games saved to ${pgnPath}`);

if (candidate.engine === 'neural' && args.save && !interrupted) {
  saveMeasuredRating(candidate.level, {
    rating: overall.rating,
    low: overall.low,
    high: overall.high,
    games: overall.games,
    opponents: args.vs,
    measuredAt: new Date().toISOString(),
  });
  console.log(`  Saved: the app now shows ${name} as ≈${overall.rating}.`);
} else if (candidate.engine === 'neural' && interrupted) {
  console.log('  Run was stopped early, so the rating was not saved to the app.');
}
process.exit(0);
