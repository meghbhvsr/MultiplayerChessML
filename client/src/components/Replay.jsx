import { useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { api, describeResult, formatDate, navigate } from '../api.js';
import MoveList from './MoveList.jsx';
import { boardTheme, highlightSquares } from './board.js';

const START_FEN = new Chess().fen();

export default function Replay({ id, user }) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState('');
  const [ply, setPly] = useState(0);

  useEffect(() => {
    api(`/games/${id}`)
      .then((g) => { setGame(g); setPly(g.moves.length); })
      .catch((e) => setError(e.message));
  }, [id]);

  const total = game?.moves.length ?? 0;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') setPly((p) => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') setPly((p) => Math.min(total, p + 1));
      if (e.key === 'Home') setPly(0);
      if (e.key === 'End') setPly(total);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  const fen = ply === 0 ? START_FEN : game?.moves[ply - 1].fen ?? START_FEN;
  const chess = useMemo(() => new Chess(fen), [fen]);

  if (error) return <div className="center error">{error}</div>;
  if (!game) return <div className="center muted">Loading…</div>;

  const uci = ply > 0 ? game.moves[ply - 1].uci : null;
  const lastMove = uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null;
  const orientation = game.black?.id === user.id ? 'black' : 'white';

  return (
    <div className="game">
      <div className="board-col">
        <div className="player-bar">
          <strong>{game.white?.username ?? '?'}</strong> <span className="muted">vs</span> <strong>{game.black?.username ?? '?'}</strong>
        </div>
        <div className="board-wrap">
          <Chessboard
            id={`replay-${id}`}
            position={fen}
            boardOrientation={orientation}
            arePiecesDraggable={false}
            customSquareStyles={highlightSquares(chess, lastMove)}
            animationDuration={150}
            {...boardTheme}
          />
        </div>
        <div className="replay-controls">
          <button onClick={() => setPly(0)} disabled={ply === 0}>⏮</button>
          <button onClick={() => setPly(ply - 1)} disabled={ply === 0}>◀</button>
          <span className="muted">{ply} / {total}</span>
          <button onClick={() => setPly(ply + 1)} disabled={ply === total}>▶</button>
          <button onClick={() => setPly(total)} disabled={ply === total}>⏭</button>
        </div>
      </div>

      <aside className="side-col">
        <div className="card status">
          <div className="status-text">{describeResult(game)}</div>
          <div className="muted">{formatDate(game.endedAt ?? game.startedAt)}</div>
        </div>
        <div className="card">
          <h3>Moves</h3>
          <MoveList moves={game.moves.map((m) => m.san)} current={ply} onSelect={setPly} />
        </div>
        <div className="card actions">
          <button onClick={() => navigate('/history')}>Back to history</button>
          <button onClick={() => navigator.clipboard.writeText(game.pgn)}>Copy PGN</button>
          {game.status === 'active' && <button className="primary" onClick={() => navigate(`/game/${id}`)}>Open live game</button>}
        </div>
      </aside>
    </div>
  );
}
