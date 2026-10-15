import { useEffect, useState } from 'react';
import { api } from '../api.js';

const SPEEDS = [['slow', '🐢 Slow'], ['normal', 'Normal'], ['fast', '⚡ Fast']];

function botLabel(b) {
  if (b.engine === 'neural') return `🧠 ${b.username}${b.rating ? ` (≈${b.rating})` : ''}`;
  return `Stockfish Lv${b.level} (≈${b.rating})`;
}

/** Lobby card: pick two bots and watch them play each other. */
export default function BotMatch({ socket, refreshKey }) {
  const [bots, setBots] = useState([]);
  const [white, setWhite] = useState(null);
  const [black, setBlack] = useState(null);
  const [speed, setSpeed] = useState('normal');

  useEffect(() => {
    api('/bots').then((list) => {
      const available = list.filter((b) => b.available);
      setBots(available);
      // Default: your neural net (if trained) vs a mid-level Stockfish.
      const neural = available.find((b) => b.engine === 'neural');
      setWhite((w) => w ?? (neural ?? available.find((b) => b.level === 3))?.level);
      setBlack((b) => b ?? available.find((x) => x.level === 5)?.level);
    });
  }, [refreshKey]);

  if (bots.length === 0) return null;

  const picker = (value, onChange) => (
    <select value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {bots.map((b) => (
        <option key={b.level} value={b.level}>{botLabel(b)}</option>
      ))}
    </select>
  );

  return (
    <section className="card">
      <h2>🤖 vs 🤖 Bot match</h2>
      <div className="match-picker">
        <label><span className="swatch white" /> White {picker(white, setWhite)}</label>
        <button
          className="ghost swap"
          title="Swap colors"
          onClick={() => {
            setWhite(black);
            setBlack(white);
          }}
        >
          ⇅
        </button>
        <label><span className="swatch black" /> Black {picker(black, setBlack)}</label>
      </div>
      <div className="row">
        <span>Speed</span>
        <div className="segmented">
          {SPEEDS.map(([key, label]) => (
            <button key={key} className={speed === key ? 'active' : ''} onClick={() => setSpeed(key)}>{label}</button>
          ))}
        </div>
        <button
          className="primary"
          disabled={!white || !black}
          onClick={() => socket.send({ type: 'create_bot_match', whiteLevel: white, blackLevel: black, speed })}
        >
          Start match
        </button>
      </div>
      <p className="hint">Watch any two bots play, including your own network against Stockfish. Matches are saved to your history.</p>
    </section>
  );
}
