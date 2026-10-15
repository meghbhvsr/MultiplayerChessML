import { useEffect, useState } from 'react';
import { api } from '../api.js';

const LEVEL_KEY = 'chess_bot_level';

function savedLevel() {
  try {
    return Number(localStorage.getItem(LEVEL_KEY)) || 3;
  } catch {
    return 3;
  }
}

export default function PlayComputer({ socket, refreshKey }) {
  const [bots, setBots] = useState([]);
  const [level, setLevel] = useState(savedLevel);
  const [color, setColor] = useState('white');

  useEffect(() => {
    api('/bots').then(setBots);
  }, [refreshKey]);

  function pickLevel(l) {
    setLevel(l);
    try { localStorage.setItem(LEVEL_KEY, String(l)); } catch { /* storage unavailable */ }
  }

  const bot = bots.find((b) => b.level === level && b.available);
  const stockfish = bots.filter((b) => b.engine === 'stockfish');
  const neural = bots.filter((b) => b.engine === 'neural');

  return (
    <section className="card">
      <h2>🤖 Play vs computer</h2>
      <div className="levels">
        {stockfish.map((b) => (
          <button key={b.level} className={b.level === level ? 'active' : ''} onClick={() => pickLevel(b.level)}>
            <span className="lvl">{b.level}</span>
            <span className="elo">≈{b.rating}</span>
          </button>
        ))}
      </div>

      {neural.length > 0 && (
        <div className="neural-row">
          <span className="muted">🧠 Your AI</span>
          {neural.map((b) => (
            <button
              key={b.level}
              className={b.level === level ? 'active' : ''}
              disabled={!b.available}
              title={b.available ? b.blurb : 'Train and export a model in ml/ to unlock'}
              onClick={() => pickLevel(b.level)}
            >
              {b.username}
            </button>
          ))}
          {!neural[0].available && <span className="hint">Train a model in <code>ml/</code> to unlock</span>}
        </div>
      )}

      {bot && (
        <div className="bot-info">
          <strong>{bot.engine === 'neural' ? bot.username : `Level ${bot.level}`}</strong>
          {bot.engine === 'neural' && <span className="muted">{bot.rating ? `≈${bot.rating} (measured)` : 'rating not measured'}</span>}
          <span className="muted">· {bot.blurb}</span>
          <span className="record">
            Your record: <span className="win">{bot.record.wins}W</span> <span className="loss">{bot.record.losses}L</span>{' '}
            <span>{bot.record.draws}D</span>
          </span>
        </div>
      )}

      <div className="row">
        <span>Play as</span>
        <div className="segmented">
          {['white', 'random', 'black'].map((c) => (
            <button key={c} className={color === c ? 'active' : ''} onClick={() => setColor(c)}>
              {c === 'white' ? '♔ White' : c === 'black' ? '♚ Black' : '⚄ Random'}
            </button>
          ))}
        </div>
        <button className="primary" disabled={!bot} onClick={() => socket.send({ type: 'create_bot_game', level, color })}>
          Play
        </button>
      </div>
      <p className="hint">Games against the computer are casual and don't change your rating.</p>
    </section>
  );
}
