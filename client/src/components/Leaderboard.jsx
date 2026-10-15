import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Leaderboard({ user, refreshKey }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api('/leaderboard').then(setRows);
  }, [refreshKey]);

  if (!rows) return <div className="center muted">Loading…</div>;

  return (
    <section className="card">
      <h2>Leaderboard</h2>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Rating</th>
            <th>Played</th>
            <th>W</th>
            <th>L</th>
            <th>D</th>
            <th>Win %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={r.id === user.id ? 'highlight' : ''}>
              <td>{['🥇', '🥈', '🥉'][i] ?? i + 1}</td>
              <td><strong>{r.username}</strong></td>
              <td>{r.rating}</td>
              <td>{r.played}</td>
              <td className="win">{r.wins}</td>
              <td className="loss">{r.losses}</td>
              <td>{r.draws}</td>
              <td>{r.played ? `${Math.round((r.wins / r.played) * 100)}%` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
