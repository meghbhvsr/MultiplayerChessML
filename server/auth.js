import jwt from 'jsonwebtoken';
import { findUserById } from './queries.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user, expiresIn = '7d') {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn });
}

/** Returns the DB user for a token, or null if the token is invalid or the user no longer exists. */
export function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    return findUserById(payload.id) ?? null;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const user = userFromToken(header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}
