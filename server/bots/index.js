import { Chess } from 'chess.js';
import { db } from '../db.js';
import { stockfishMove } from './stockfish.js';
import { neuralMove, neuralModelAvailable, measuredRating } from './neural.js';

/**
 * Computer opponents. Each level is a bot user in the database so bot games use the normal games/moves
 * tables. `rating` is a rough estimate shown to players; bot games are unrated so it never changes.
 * `randomness` is the chance of playing a random legal move, which keeps the low levels beatable
 * (Stockfish at skill 0 is still too strong for beginners).
 *
 * To add a different engine later (e.g. a trained neural network), give a level a new `engine` value
 * and handle it in chooseBotMove().
 */
export const BOT_LEVELS = [
  { level: 1, rating: 400, engine: 'stockfish', skill: 0, depth: 1, randomness: 0.5, blurb: 'Just learned the rules' },
  { level: 2, rating: 700, engine: 'stockfish', skill: 0, depth: 2, randomness: 0.25, blurb: 'Casual beginner' },
  { level: 3, rating: 1000, engine: 'stockfish', skill: 2, depth: 3, randomness: 0.1, blurb: 'Knows the basics' },
  { level: 4, rating: 1300, engine: 'stockfish', skill: 5, depth: 5, blurb: 'Club beginner' },
  { level: 5, rating: 1600, engine: 'stockfish', skill: 9, depth: 8, blurb: 'Solid club player' },
  { level: 6, rating: 1900, engine: 'stockfish', skill: 13, depth: 11, blurb: 'Strong club player' },
  { level: 7, rating: 2300, engine: 'stockfish', skill: 17, depth: 14, movetime: 1000, blurb: 'Master strength' },
  { level: 8, rating: 3000, engine: 'stockfish', skill: 20, depth: 30, movetime: 1500, blurb: 'Full-strength Stockfish' },

  // Your own network from ml/. Rating comes from `npm run arena`; 0 = not measured yet (shown as "?").
  { level: 9, rating: 0, engine: 'neural', name: 'NeuralNet Instinct', search: false, blurb: 'Plays its first instinct, no calculation' },
  { level: 10, rating: 0, engine: 'neural', name: 'NeuralNet Search', search: true, nodes: 400, movetime: 3000, blurb: 'Network + tree search (AlphaZero-style)' },
];

export const botUsername = (level) => BOT_LEVELS.find((b) => b.level === level)?.name ?? `Stockfish Lv${level}`;

const isAvailable = (config) => config.engine !== 'neural' || neuralModelAvailable();
export const ratingFor = (config) => (config.engine === 'neural' ? measuredRating(config.level) : config.rating);

const sql = {
  upsertBot: db.prepare(`
    INSERT INTO users (username, password_hash, rating, is_bot, bot_level) VALUES (@username, '', @rating, 1, @level)
    ON CONFLICT(username) DO UPDATE SET rating = @rating, is_bot = 1, bot_level = @level
  `),
  botByLevel: db.prepare('SELECT id, username, rating, bot_level FROM users WHERE is_bot = 1 AND bot_level = ?'),
  setRating: db.prepare('UPDATE users SET rating = ? WHERE is_bot = 1 AND bot_level = ? AND rating != ?'),
};

/** Creates or updates the bot users. Called once at startup. */
export function seedBots() {
  for (const b of BOT_LEVELS) sql.upsertBot.run({ username: botUsername(b.level), rating: ratingFor(b), level: b.level });
}

/** The bot user for a level, or undefined if that level doesn't exist or isn't available (no trained model yet). */
export function findBotByLevel(level) {
  const config = BOT_LEVELS.find((b) => b.level === level);
  return config && isAvailable(config) ? sql.botByLevel.get(level) : undefined;
}

export function listBots() {
  // Neural ratings can change while the server runs (arena results, re-exported model): keep the bot users in sync.
  for (const b of BOT_LEVELS) {
    if (b.engine === 'neural') sql.setRating.run(ratingFor(b), b.level, ratingFor(b));
  }
  return BOT_LEVELS.map((b) => ({
    level: b.level,
    rating: ratingFor(b),
    blurb: b.blurb,
    engine: b.engine,
    available: isAvailable(b),
    username: botUsername(b.level),
  }));
}

function randomMove(fen) {
  const moves = new Chess(fen).moves({ verbose: true });
  const m = moves[Math.floor(Math.random() * moves.length)];
  return m.from + m.to + (m.promotion ?? '');
}

/** Returns the bot's move for the position in UCI notation. */
export async function chooseBotMove(level, fen) {
  const config = BOT_LEVELS.find((b) => b.level === level);
  if (!config) throw new Error(`Unknown bot level ${level}`);
  if (config.randomness && Math.random() < config.randomness) return randomMove(fen);
  switch (config.engine) {
    case 'stockfish':
      return stockfishMove(fen, config);
    case 'neural':
      return neuralMove(fen, config);
    default:
      throw new Error(`Unknown engine ${config.engine}`);
  }
}
