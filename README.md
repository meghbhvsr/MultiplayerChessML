# Chess Multiplayer

Real-time chess in the browser. Play friends, play Stockfish at 8 levels, or play **a neural network trained
from scratch on 21 million positions from strong human games**. You can also make any two bots play each
other and watch.

- **Multiplayer:** live games over WebSockets, with accounts, guest play, invite links, chat, draw offers and resignation
- **Ratings:** Elo for human-vs-human games, a leaderboard, and full game history with move-by-move replay
- **Play vs computer:** Stockfish levels 1–8 (≈400 to ≈3000), plus your own neural network bots
- **Bot vs Bot:** pick any two bots and watch them play, with speed control
- **Arena:** a script that measures a bot's rating by playing it against Stockfish

| | |
|---|---|
| Client | React 18 (Vite), react-chessboard, chess.js |
| Server | Node.js, Express (REST), `ws` (WebSockets), chess.js |
| Database | SQLite via better-sqlite3 (`server/chess.db`, created automatically) |
| Engines | Stockfish 18 (WASM, npm `stockfish`), ONNX Runtime for the neural network |
| ML | Python, PyTorch (CUDA), python-chess; see [ml/README.md](ml/README.md) |

---

## Getting started

Requires Node.js 18+ (developed on Node 22).

```powershell
npm run install:all   # installs root, server and client dependencies
npm run dev           # game server on :3001 + web app on :5173, both auto-reload on changes
```

Open **http://localhost:5173**. Sign up, or click **Play as guest**. Ctrl+C stops everything.

- **Testing multiplayer alone:** open a second browser or an incognito window and play as a guest.
- **Playing a friend on your network:** run `npm run dev --prefix server` in one terminal and `npx vite --host`
  in `client/` in another. Your friend opens `http://<your-PC's-IP>:5173` (find it with `ipconfig`).
- **The neural network bots** need the trained model at `server/models/chessnet.onnx`. It's not in git
  (45 MB); see [Your neural network](#your-neural-network). Everything else works without it.

### Production

```powershell
npm run build   # builds the web app into client/dist
npm start       # one server on :3001 serves the app, API and WebSocket
```

`npm start` doesn't reload on code changes: restart it (and re-run `npm run build` for client changes) after updating.

### Configuration (environment variables, all optional)

| Variable | Default | |
|---|---|---|
| `PORT` | `3001` | Server port |
| `JWT_SECRET` | `dev-secret-change-me` | **Set this in production.** Signs login tokens |
| `DB_PATH` | `server/chess.db` | SQLite database file |
| `BOT_ENGINES` | `2` | Stockfish processes run in parallel (bot games thinking at once) |
| `STOCKFISH_PATH` | (WASM build) | Path to a native Stockfish binary: much faster and stronger |
| `NEURAL_MODEL` | `server/models/chessnet.onnx` | The trained network used by the NeuralNet bots |

> **PowerShell tip:** to pass options to an npm script, use `npm.cmd` instead of `npm` and quote lists, e.g.
> `npm.cmd run arena -- --vs "5,6,7"`. PowerShell's `npm` wrapper drops the `--`, so you'd only see npm's version.

---

## Accounts and multiplayer

- **Sign up** with a username (3–20 letters, numbers, `_ . -`) and password (6+ characters, stored as a bcrypt hash).
- **Guests** get an ID like `Guest_48213` with one click. They can play and have history, but don't appear on the
  leaderboard and can't log back in after logging out.
- **Create a game** as white, black or random. It's listed in the lobby, and you get an **invite link** to send.
  Anyone who opens the link can join, as a guest if they have no account.
- **In game:** moves are validated on the server, with last-move and check highlighting, pawn promotion, draw offers,
  resignation and chat. Games survive disconnects and server restarts.
- **Endings detected:** checkmate, resignation, stalemate, agreement, threefold repetition, 50-move rule,
  insufficient material.
- **Ratings:** standard Elo (K=32, start 1200) for human-vs-human games only. Games against bots are casual.

---

## Computer opponents

Bots are regular users in the database (`users.is_bot = 1`), so their games use the same tables, history and
replays as human games. All bot games are **unrated**. Levels are configured in
[server/bots/index.js](server/bots/index.js).

### Stockfish levels

| Level | Est. rating | Stockfish settings | Notes |
|---|---|---|---|
| 1 | ≈400 | skill 0, depth 1 | 50% random moves: just learned the rules |
| 2 | ≈700 | skill 0, depth 2 | 25% random moves |
| 3 | ≈1000 | skill 2, depth 3 | 10% random moves |
| 4 | ≈1300 | skill 5, depth 5 | |
| 5 | ≈1600 | skill 9, depth 8 | |
| 6 | ≈1900 | skill 13, depth 11 | |
| 7 | ≈2300 | skill 17, depth 14, 1 s | |
| 8 | ≈3000 | skill 20, 1.5 s | Full-strength Stockfish |

The ratings are rough estimates and are the reference point for the arena (below). Low levels mix in random moves
because Stockfish's weakest setting is still too strong for beginners. Stockfish runs as child processes, so a bot
thinking never blocks the game server.

### Your neural network

Two bots run the network trained in [ml/](ml/README.md). They unlock under **🧠 Your AI** once
`server/models/chessnet.onnx` exists.

| Bot | How it picks a move | Speed | Measured rating |
|---|---|---|---|
| **NeuralNet Instinct** | Plays the network's top move straight away, without looking ahead | Instant | not yet measured (≈1150 in a short test) |
| **NeuralNet Search** | Uses that instinct to choose candidate moves, then runs an AlphaZero-style tree search (400 evaluations): it plays lines out in its head, judges the resulting positions with the network, and plays the move it explored most | ≈1.7 s per move | **≈1720** |

**The model:** a residual CNN (10 blocks × 128 channels, 11.5M parameters) with two outputs:
- a **policy**: a probability for every move, trained to predict what a strong player would play
- a **value**: win/draw/loss chances for the side to move, trained on game results

It was trained with supervised learning on 300,000 Lichess games where both players were rated 2000+
(21.4M positions, 4 epochs on an RTX 3060 Ti). It predicts the strong player's exact move **53.3%** of the time
on held-out games.

**Measured strength** (`npm run arena`, 16 games per opponent, each opening played with both colors):

| NeuralNet Search vs | W | D | L | Score |
|---|---|---|---|---|
| Stockfish Lv4 (≈1300) | 15 | 1 | 0 | 97% |
| Stockfish Lv5 (≈1600) | 6 | 6 | 4 | 56% |
| Stockfish Lv6 (≈1900) | 2 | 6 | 8 | 31% |

All 48 games together: a performance of about **1720**. That's comfortably above Lv4, a bit stronger than Lv5,
and below Lv6. Ratings are anchored to the Stockfish levels' estimates, so the absolute number is approximate.

**The model is not in git** (45 MB). On a new machine, copy `server/models/chessnet.onnx` over, or recreate it with
the ML pipeline: `prepare_data.py` → `train.py` → `export_onnx.py` (all steps in [ml/README.md](ml/README.md)).
The server picks up a newly exported model on the next bot move, with no restart.

### Bot vs Bot

In the lobby's **🤖 vs 🤖 Bot match** card, pick any two bots (Stockfish levels or your NeuralNet bots) and a speed
(🐢 slow 2 s, normal 0.8 s, ⚡ fast: minimum time per move). While it plays you can change the speed or stop it.
Afterwards you can rematch or swap colors. Matches are saved to your history (as "watched") and can be replayed.
Up to 3 matches per user can run at once.

### Arena: measuring a bot's rating

```powershell
npm.cmd run arena                                # NeuralNet Search vs Stockfish Lv4, 5, 6 — 16 games each
npm.cmd run arena -- --vs "5,6,7" --games 24     # stronger opponents, more games = tighter estimate
npm.cmd run arena -- --bot 9 --vs "2,3,4"         # measure NeuralNet Instinct
```

Each of 16 common openings is played twice with colors swapped. The arena prints each result as it finishes, then
W/D/L per opponent and an estimated rating with a 95% range. Games are saved as PGN in `server/arena/`. For
neural bots the rating is saved to `server/models/chessnet.json` and shown in the app instead of "?"; re-exporting
a model resets it. It uses an in-memory database and never touches your real data. Ctrl+C stops early and reports
the games so far. Pick opponents near the bot's strength: if it wins or loses everything, the number isn't informative.

---

## Project structure

```
client/                  React app (Vite)
  src/App.jsx            routing (#/lobby, #/game/:id, #/replay/:id, #/history, #/leaderboard), socket handling
  src/components/        Lobby, GameView, PlayComputer, BotMatch, History, Replay, Leaderboard, AuthPage, …
server/
  index.js               Express + HTTP server; serves client/dist in production
  routes.js              REST API (auth, history, leaderboard, bots)
  realtime.js            WebSocket hub: lobby, games, move validation, bot moves, bot matches
  db.js, queries.js      SQLite schema/migrations and queries
  bots/index.js          bot levels and move selection
  bots/stockfish.js      Stockfish process pool (UCI over stdin/stdout)
  bots/neural.js         neural network inference (ONNX Runtime) + MCTS search
  scripts/arena.js       rating measurement
  models/                trained model (not in git)
ml/                      training pipeline (Python); see ml/README.md
```

---

## How it works

The server is authoritative: every move, from a human or a bot, is validated with chess.js on the server before it's
saved and broadcast. Clients show their own moves immediately (optimistic update) and resync from the server.
Bot moves are computed in the background and go through exactly the same code path as human moves.

### Database

| Table | What it stores |
|---|---|
| `users` | username, bcrypt password hash, rating, `is_guest`, `is_bot`, `bot_level` |
| `games` | players, creator, status (`waiting` / `active` / `finished` / `cancelled`), result, reason, `rated`, current FEN, PGN, rating changes, timestamps |
| `moves` | every move of every game (SAN, UCI, FEN after the move) for replays |

Win/loss/draw stats are computed from `games` (rated games only), so they can't drift out of sync. Columns added in
later versions are migrated automatically on startup.

### REST API (`Authorization: Bearer <token>`)

| Method | Path | |
|---|---|---|
| POST | `/api/register` | `{username, password}` → `{token, user}` |
| POST | `/api/login` | `{username, password}` → `{token, user}` |
| POST | `/api/guest` | creates a guest account → `{token, user}` |
| GET | `/api/me` | current user + rated-game stats |
| GET | `/api/me/games` | your games and bot matches (active, finished, stopped) |
| GET | `/api/games/:id` | a game with all moves |
| GET | `/api/leaderboard` | top 50 by rating (no guests or bots) |
| GET | `/api/bots` | bot levels, availability, ratings, and your record against each |

### WebSocket (`/ws?token=<jwt>`)

Client → server (game messages take `gameId`):

| Message | |
|---|---|
| `create_game {color}`, `join_game`, `cancel_game` | games between people |
| `watch_game`, `unwatch_game` | subscribe to a game's updates (players and spectators) |
| `move {from, to, promotion}`, `resign`, `offer_draw`, `respond_draw {accept}`, `chat {text}` | in-game actions |
| `create_bot_game {level, color}` | play against a bot |
| `create_bot_match {whiteLevel, blackLevel, speed}`, `set_match_speed {speed}`, `stop_match` | bot vs bot |

Server → client: `hello`, `lobby`, `online`, `game_state` (includes `botThinking` and `matchSpeed`), `game_created`,
`game_started`, `chat`, `error`.
