import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { describeResult, isBotMatch, navigate } from '../api.js';
import MoveList from './MoveList.jsx';
import { boardTheme, highlightSquares } from './board.js';

export default function GameView({ id, user, socket, game, chat }) {
  const [optimisticFen, setOptimisticFen] = useState(null);

  useEffect(() => {
    socket.watch(id);
    return () => socket.unwatch(id);
  }, [socket, id]);

  // Any update from the server replaces our optimistic position.
  useEffect(() => {
    setOptimisticFen(null);
  }, [game]);

  const chess = useMemo(() => new Chess(optimisticFen ?? game?.fen), [optimisticFen, game?.fen]);

  if (!game) return <div className="center muted">Loading game…</div>;

  const myColor = game.white?.id === user.id ? 'white' : game.black?.id === user.id ? 'black' : null;
  const isActive = game.status === 'active';
  const myTurn = isActive && myColor && chess.turn() === myColor[0];
  const orientation = myColor ?? 'white';
  const top = orientation === 'white' ? game.black : game.white;
  const bottom = orientation === 'white' ? game.white : game.black;
  const opponent = myColor === 'white' ? game.black : myColor === 'black' ? game.white : null;
  const opponentId = opponent?.id;
  const vsBot = !!opponent?.isBot;
  const match = isBotMatch(game);
  const sideToMove = chess.turn() === 'w' ? game.white : game.black;
  const startMatch = (whiteLevel, blackLevel) =>
    socket.send({ type: 'create_bot_match', whiteLevel, blackLevel, speed: game.matchSpeed });

  function onPieceDrop(from, to, piece) {
    if (!myTurn) return false;
    const next = new Chess(game.fen);
    const promo = piece?.[1]?.toLowerCase();
    let move;
    try {
      move = next.move({ from, to, promotion: promo && promo !== 'p' ? promo : 'q' });
    } catch {
      return false;
    }
    setOptimisticFen(next.fen());
    socket.send({ type: 'move', gameId: id, from, to, promotion: move.promotion });
    return true;
  }

  let status;
  if (game.status === 'waiting') status = 'Waiting for an opponent to join…';
  else if (game.status === 'cancelled') status = match ? 'Match stopped.' : 'This game was cancelled.';
  else if (game.status === 'finished') status = describeResult(game);
  else if (match) status = `${sideToMove.username} is thinking…`;
  else if (myTurn) status = chess.inCheck() ? 'Check! Your move' : 'Your move';
  else if (vsBot) status = `${opponent.username} is thinking…`;
  else if (myColor && game.moves.length === 0) status = `You're black. White (${top?.username}) moves first…`;
  else if (myColor) status = `Waiting for ${top?.username} to move…`;
  else status = `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;

  const outcomeClass =
    game.status !== 'finished' || !myColor ? '' :
    game.result === 'draw' ? 'draw' : game.result === myColor ? 'win' : 'loss';

  return (
    <div className="game">
      <div className="board-col">
        <PlayerBar
          player={top}
          color={orientation === 'white' ? 'black' : 'white'}
          toMove={isActive && chess.turn() !== orientation[0]}
          thinking={game.botThinking && top?.isBot && chess.turn() !== orientation[0]}
        />
        <div className="board-wrap">
          <Chessboard
            id={`game-${id}`}
            position={optimisticFen ?? game.fen}
            boardOrientation={orientation}
            onPieceDrop={onPieceDrop}
            isDraggablePiece={({ piece }) => !!myTurn && piece[0] === myColor[0]}
            customSquareStyles={highlightSquares(chess, game.lastMove)}
            animationDuration={200}
            {...boardTheme}
          />
        </div>
        <PlayerBar
          player={bottom}
          color={orientation}
          toMove={isActive && chess.turn() === orientation[0]}
          thinking={game.botThinking && bottom?.isBot && chess.turn() === orientation[0]}
        />
      </div>

      <aside className="side-col">
        <div className={`card status ${outcomeClass}`}>
          {myColor && game.status !== 'waiting' && (
            <div className="muted"><span className={`swatch ${myColor}`} /> You are playing {myColor}</div>
          )}
          {match && <div className="muted">🤖 vs 🤖 Bot match</div>}
          <div className="status-text">{status}</div>
          {match && game.status === 'finished' && game.result !== 'draw' && (
            <div className="outcome">🏆 {game[game.result].username}</div>
          )}
          {!game.rated && !match && game.status !== 'waiting' && <div className="hint">Casual game · rating not affected</div>}
          {outcomeClass && <div className="outcome">{{ win: 'You won! 🎉', loss: 'You lost', draw: 'Draw' }[outcomeClass]}</div>}
        </div>

        {game.status === 'waiting' && myColor && <InviteCard id={id} socket={socket} />}

        {game.status === 'waiting' && !myColor && (
          <div className="card actions">
            <span><strong>{game.creator.username}</strong> is waiting for an opponent.</span>
            <button className="primary" onClick={() => socket.send({ type: 'join_game', gameId: id })}>
              Join as {game.white ? 'black' : 'white'}
            </button>
          </div>
        )}

        {isActive && myColor && (
          <div className="card actions">
            {vsBot ? null : game.drawOfferFrom === opponentId ? (
              <>
                <span>{top?.username} offers a draw</span>
                <button className="primary" onClick={() => socket.send({ type: 'respond_draw', gameId: id, accept: true })}>Accept</button>
                <button onClick={() => socket.send({ type: 'respond_draw', gameId: id, accept: false })}>Decline</button>
              </>
            ) : (
              <button disabled={game.drawOfferFrom === user.id} onClick={() => socket.send({ type: 'offer_draw', gameId: id })}>
                {game.drawOfferFrom === user.id ? 'Draw offered' : '½ Offer draw'}
              </button>
            )}
            <button
              className="danger"
              onClick={() => confirm('Resign this game?') && socket.send({ type: 'resign', gameId: id })}
            >
              ⚑ Resign
            </button>
          </div>
        )}

        {match && isActive && game.creator.id === user.id && (
          <div className="card actions">
            <span>Speed</span>
            <div className="segmented">
              {[['slow', '🐢 Slow'], ['normal', 'Normal'], ['fast', '⚡ Fast']].map(([key, label]) => (
                <button
                  key={key}
                  className={game.matchSpeed === key ? 'active' : ''}
                  onClick={() => socket.send({ type: 'set_match_speed', gameId: id, speed: key })}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="danger" onClick={() => socket.send({ type: 'stop_match', gameId: id })}>■ Stop match</button>
          </div>
        )}

        <div className="card">
          <h3>Moves</h3>
          <MoveList moves={game.moves} />
        </div>

        {(game.status === 'finished' || game.status === 'cancelled') && (
          <div className="card actions">
            {match && (
              <>
                <button className="primary" onClick={() => startMatch(game.white.botLevel, game.black.botLevel)}>Rematch</button>
                <button onClick={() => startMatch(game.black.botLevel, game.white.botLevel)}>Swap colors</button>
              </>
            )}
            {vsBot && (
              <button
                className="primary"
                onClick={() => socket.send({ type: 'create_bot_game', level: opponent.botLevel, color: myColor })}
              >
                Play again
              </button>
            )}
            <button onClick={() => navigate('/lobby')}>Back to lobby</button>
            {game.moves.length > 0 && <button onClick={() => navigate(`/replay/${id}`)}>Replay</button>}
          </div>
        )}

        {!vsBot && !match && <Chat chat={chat} onSend={(text) => socket.send({ type: 'chat', gameId: id, text })} />}
      </aside>
    </div>
  );
}

function InviteCard({ id, socket }) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}${location.pathname}#/game/${id}`;

  function copy(e) {
    const input = e.currentTarget.previousSibling;
    input.select();
    // navigator.clipboard only exists on https/localhost; fall back for http://<LAN-IP>.
    const done = navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.resolve(document.execCommand('copy'));
    done.then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="card invite">
      <h3>Invite an opponent</h3>
      <p className="muted">
        Send this link to a friend. They can join as a guest, no account needed. Your game is also listed in the lobby.
      </p>
      <div className="copy-row">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button className="primary" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
      </div>
      <p className="hint">
        Testing alone? Open the link in an incognito/private window and click “Play as guest”.
      </p>
      <button onClick={() => socket.send({ type: 'cancel_game', gameId: id })}>Cancel game</button>
    </div>
  );
}

function PlayerBar({ player, color, toMove, thinking }) {
  return (
    <div className={`player-bar ${toMove ? 'to-move' : ''}`}>
      <span className={`swatch ${color}`} />
      <strong>{player?.isBot ? '🤖 ' : ''}{player?.username ?? 'Waiting…'}</strong>
      {player && <span className="muted">{player.isBot ? (player.rating ? `≈${player.rating}` : '?') : player.rating}</span>}
      {thinking && <span className="thinking"><i /><i /><i /></span>}
      {player?.ratingChange != null && (
        <span className={player.ratingChange >= 0 ? 'win' : 'loss'}>
          {player.ratingChange >= 0 ? '+' : ''}{player.ratingChange}
        </span>
      )}
    </div>
  );
}

function Chat({ chat, onSend }) {
  const [text, setText] = useState('');
  const boxRef = useRef(null);
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chat.length]);

  return (
    <div className="card chat">
      <h3>Chat</h3>
      <div className="messages" ref={boxRef}>
        {chat.length === 0 && <div className="muted">Say hi 👋</div>}
        {chat.map((m, i) => (
          <div key={i}><strong>{m.from}:</strong> {m.text}</div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSend(text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…" maxLength={500} />
      </form>
    </div>
  );
}
