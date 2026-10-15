import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { signToken, requireAuth } from './auth.js';
import {
  createUser, findUserByName, getUserStats, getLeaderboard,
  getGameRow, getMoves, serializeGame, listUserGames, getBotRecord,
} from './queries.js';
import { listBots } from './bots/index.js';

export const apiRouter = Router();

/** Returns an error message for an unacceptable username, or null if it's fine. */
function usernameProblem(username) {
  if (username.length < 3 || username.length > 20) return 'Username must be 3–20 characters';
  if (/\s/.test(username)) return 'Username cannot contain spaces';
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username can only use letters, numbers, and _ . -';
  if (/^guest/i.test(username)) return 'Usernames starting with "guest" are reserved for guests';
  if (/^stockfish/i.test(username)) return 'Usernames starting with "stockfish" are reserved for the computer';
  return null;
}

apiRouter.post('/register', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const { password } = req.body ?? {};
  const problem = usernameProblem(username);
  if (problem) return res.status(400).json({ error: problem });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (findUserByName(username)) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  const hash = await bcrypt.hash(password, 10);
  const id = createUser(username, hash);
  const user = getUserStats(id);
  res.status(201).json({ token: signToken(user), user });
});

apiRouter.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const row = typeof username === 'string' ? findUserByName(username.trim()) : null;
  if (!row || row.is_guest || row.is_bot || typeof password !== 'string' || !(await bcrypt.compare(password, row.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = getUserStats(row.id);
  res.json({ token: signToken(user), user });
});

/** Creates a throwaway account named like "Guest_48213". Guests can play but don't appear on the leaderboard. */
apiRouter.post('/guest', (req, res) => {
  let username;
  do {
    username = `Guest_${Math.floor(10000 + Math.random() * 90000)}`;
  } while (findUserByName(username));
  const id = createUser(username, '', true);
  const user = getUserStats(id);
  res.status(201).json({ token: signToken(user, '30d'), user });
});

apiRouter.get('/me', requireAuth, (req, res) => {
  res.json(getUserStats(req.user.id));
});

apiRouter.get('/me/games', requireAuth, (req, res) => {
  res.json(listUserGames(req.user.id));
});

apiRouter.get('/leaderboard', requireAuth, (req, res) => {
  res.json(getLeaderboard());
});

/** Computer levels, with the current user's record against each. */
apiRouter.get('/bots', requireAuth, (req, res) => {
  const record = new Map(getBotRecord(req.user.id).map((r) => [r.level, r]));
  res.json(listBots().map((b) => ({ ...b, record: record.get(b.level) ?? { wins: 0, losses: 0, draws: 0 } })));
});

apiRouter.get('/games/:id', requireAuth, (req, res) => {
  const row = getGameRow(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Game not found' });
  res.json({ ...serializeGame(row), moves: getMoves(row.id) });
});
