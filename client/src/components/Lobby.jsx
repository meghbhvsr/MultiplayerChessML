import { useEffect, useState } from 'react';
import { api, isBotMatch, navigate, playerName } from '../api.js';
import PlayComputer from './PlayComputer.jsx';
import BotMatch from './BotMatch.jsx';

export default function Lobby({ user, socket, openGames, online, refreshKey }) {
  const [color, setColor] = useState('random');
  const [activeGames, setActiveGames] = useState([]);

  useEffect(() => {
    api('/me/games').then((games) => setActiveGames(games.filter((g) => g.status === 'active')));
  }, [refreshKey, openGames]);

  const myOpenGame = openGames.find((g) => g.creator.id === user.id);
  const others = openGames.filter((g) => g.creator.id !== user.id);

  return (
    <div className="lobby">
      <section className="card">
        <h2>Your stats <span className="muted">(rated games)</span></h2>
        <div className="stats">
          <Stat label="Rating" value={user.rating} />
          <Stat label="Played" value={user.played} />
          <Stat label="Wins" value={user.wins} className="win" />
          <Stat label="Losses" value={user.losses} className="loss" />
          <Stat label="Draws" value={user.draws} />
        </div>
      </section>

      <PlayComputer socket={socket} refreshKey={refreshKey} />

      <BotMatch socket={socket} refreshKey={refreshKey} />

      <section className="card">
        <h2>Play a friend</h2>
        {myOpenGame ? (
          <div className="row">
            <span className="muted">You have a game waiting for an opponent.</span>
            <button className="primary" onClick={() => navigate(`/game/${myOpenGame.id}`)}>Open</button>
            <button onClick={() => socket.send({ type: 'cancel_game', gameId: myOpenGame.id })}>Cancel</button>
          </div>
        ) : (
          <div className="row">
            <span>Play as</span>
            <div className="segmented">
              {['white', 'random', 'black'].map((c) => (
                <button key={c} className={color === c ? 'active' : ''} onClick={() => setColor(c)}>
                  {c === 'white' ? '♔ White' : c === 'black' ? '♚ Black' : '⚄ Random'}
                </button>
              ))}
            </div>
            <button className="primary" onClick={() => socket.send({ type: 'create_game', color })}>Create game</button>
          </div>
        )}
      </section>

      {activeGames.length > 0 && (
        <section className="card">
          <h2>Your games in progress</h2>
          <ul className="list">
            {activeGames.map((g) => {
              const moves = <span className="muted">· {g.moveCount} moves</span>;
              if (isBotMatch(g)) {
                return (
                  <li key={g.id}>
                    <span><strong>{playerName(g.white)}</strong> vs <strong>{playerName(g.black)}</strong> {moves}</span>
                    <button className="primary" onClick={() => navigate(`/game/${g.id}`)}>Watch</button>
                  </li>
                );
              }
              const opp = g.white.id === user.id ? g.black : g.white;
              return (
                <li key={g.id}>
                  <span>vs <strong>{playerName(opp)}</strong> {moves}</span>
                  <button className="primary" onClick={() => navigate(`/game/${g.id}`)}>Resume</button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Open games</h2>
        {others.length === 0 ? (
          <p className="muted">No one is waiting right now. Create a game and a friend can join it here.</p>
        ) : (
          <ul className="list">
            {others.map((g) => {
              const creatorColor = g.white ? 'white' : 'black';
              const rating = g.white?.rating ?? g.black?.rating;
              return (
                <li key={g.id}>
                  <span>
                    <strong>{g.creator.username}</strong> <span className="muted">({rating}) plays {creatorColor}</span>
                  </span>
                  <button className="primary" onClick={() => socket.send({ type: 'join_game', gameId: g.id })}>
                    Join as {creatorColor === 'white' ? 'black' : 'white'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Online now <span className="muted">({online.length})</span></h2>
        <div className="chips">
          {online.map((u) => (
            <span key={u.id} className={`chip ${u.id === user.id ? 'me' : ''}`}>{u.username}</span>
          ))}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, className = '' }) {
  return (
    <div className={`stat ${className}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}
