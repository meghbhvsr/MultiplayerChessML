import { useEffect, useState } from 'react';
import { api, describeResult, formatDate, isBotMatch, navigate, outcomeFor, playerName } from '../api.js';

export default function History({ user, refreshKey }) {
  const [games, setGames] = useState(null);

  useEffect(() => {
    api('/me/games').then(setGames);
  }, [refreshKey]);

  if (!games) return <div className="center muted">Loading…</div>;

  return (
    <section className="card">
      <h2>Game history</h2>
      {games.length === 0 ? (
        <p className="muted">You haven't played any games yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Opponent</th>
              <th>Color</th>
              <th>Result</th>
              <th>Moves</th>
              <th>Rating</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {games.map((g) => {
              const match = isBotMatch(g);
              const mine = g.white?.id === user.id ? 'white' : 'black';
              const opp = mine === 'white' ? g.black : g.white;
              const outcome = match ? null : outcomeFor(g, user.id);
              const change = match ? null : g[mine]?.ratingChange;
              return (
                <tr key={g.id}>
                  <td>{formatDate(g.endedAt ?? g.startedAt)}</td>
                  <td>
                    {match ? (
                      <><strong>{playerName(g.white)}</strong> <span className="muted">vs</span> <strong>{playerName(g.black)}</strong></>
                    ) : (
                      <strong>{playerName(opp)}</strong>
                    )}
                  </td>
                  <td>{match ? <span className="muted">watched</span> : <><span className={`swatch ${mine}`} /> {mine}</>}</td>
                  <td>
                    {outcome && <span className={`badge ${outcome}`}>{outcome}</span>}{' '}
                    <span className="muted">{describeResult(g)}</span>
                  </td>
                  <td>{Math.ceil(g.moveCount / 2)}</td>
                  <td className={change > 0 ? 'win' : change < 0 ? 'loss' : ''}>
                    {change != null ? `${change > 0 ? '+' : ''}${change}` : g.rated ? '–' : <span className="muted">casual</span>}
                  </td>
                  <td>
                    {g.status === 'active' ? (
                      <button className="primary" onClick={() => navigate(`/game/${g.id}`)}>{match ? 'Watch' : 'Resume'}</button>
                    ) : (
                      <button onClick={() => navigate(`/replay/${g.id}`)}>Replay</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
