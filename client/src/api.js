const TOKEN_KEY = 'chess_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export const navigate = (path) => { location.hash = path; };

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** SQLite stores UTC as "YYYY-MM-DD HH:MM:SS". */
export function parseDate(s) {
  return s ? new Date(s.replace(' ', 'T') + 'Z') : null;
}

export function formatDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

export const isBotMatch = (game) => !!(game.white?.isBot && game.black?.isBot);

export const playerName = (p) => (p ? `${p.isBot ? '🤖 ' : ''}${p.username}` : '?');

export function describeResult(game) {
  if (game.status === 'cancelled') return game.moveCount || game.moves?.length ? 'Stopped' : 'Cancelled';
  if (game.status !== 'finished') return 'In progress';
  if (game.result === 'draw') return `Draw by ${game.reason}`;
  const winner = game.result === 'white' ? 'White' : 'Black';
  return `${winner} wins by ${game.reason}`;
}

/** 'win' | 'loss' | 'draw' | null from the given user's perspective. */
export function outcomeFor(game, userId) {
  if (game.status !== 'finished') return null;
  if (game.result === 'draw') return 'draw';
  const winnerId = game.result === 'white' ? game.white?.id : game.black?.id;
  return winnerId === userId ? 'win' : 'loss';
}
