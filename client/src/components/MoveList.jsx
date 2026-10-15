import { useEffect, useRef } from 'react';

/** Moves shown as numbered white/black pairs. `current` (1-based ply) highlights a move; `onSelect` makes them clickable. */
export default function MoveList({ moves, current, onSelect }) {
  const boxRef = useRef(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box && current == null) box.scrollTop = box.scrollHeight;
  }, [moves.length, current]);

  if (moves.length === 0) return <div className="muted">No moves yet.</div>;

  const rows = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([i, moves[i], moves[i + 1]]);

  const cell = (san, ply) =>
    san ? (
      <span
        className={`san ${current === ply ? 'current' : ''} ${onSelect ? 'clickable' : ''}`}
        onClick={onSelect ? () => onSelect(ply) : undefined}
      >
        {san}
      </span>
    ) : <span />;

  return (
    <div className="moves" ref={boxRef}>
      {rows.map(([i, w, b]) => (
        <div className="move-row" key={i}>
          <span className="num">{i / 2 + 1}.</span>
          {cell(w, i + 1)}
          {cell(b, i + 2)}
        </div>
      ))}
    </div>
  );
}
