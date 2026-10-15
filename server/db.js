import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(process.env.DB_PATH || path.join(dir, 'chess.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    rating        INTEGER NOT NULL DEFAULT 1200,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    white_id            INTEGER REFERENCES users(id),
    black_id            INTEGER REFERENCES users(id),
    creator_id          INTEGER NOT NULL REFERENCES users(id),
    status              TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'finished', 'cancelled')),
    result              TEXT CHECK (result IN ('white', 'black', 'draw')),
    reason              TEXT,
    fen                 TEXT NOT NULL,
    pgn                 TEXT NOT NULL DEFAULT '',
    white_rating_change INTEGER,
    black_rating_change INTEGER,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    started_at          TEXT,
    ended_at            TEXT
  );

  CREATE TABLE IF NOT EXISTS moves (
    game_id   INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    ply       INTEGER NOT NULL,
    san       TEXT NOT NULL,
    uci       TEXT NOT NULL,
    fen       TEXT NOT NULL,
    played_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_id, ply)
  );

  CREATE INDEX IF NOT EXISTS idx_games_white  ON games(white_id);
  CREATE INDEX IF NOT EXISTS idx_games_black  ON games(black_id);
  CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
`);

// Migrations for databases created by earlier versions.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('users', 'is_guest', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'bot_level', 'INTEGER');
addColumn('games', 'rated', 'INTEGER NOT NULL DEFAULT 1'); // games vs the computer are unrated
