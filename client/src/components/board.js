export const boardTheme = {
  customDarkSquareStyle: { backgroundColor: '#769656' },
  customLightSquareStyle: { backgroundColor: '#eeeed2' },
  customBoardStyle: { borderRadius: '6px', boxShadow: '0 6px 24px rgba(0,0,0,0.35)' },
};

/** Square styles for the last move and a king in check. */
export function highlightSquares(chess, lastMove) {
  const styles = {};
  if (lastMove) {
    styles[lastMove.from] = { backgroundColor: 'rgba(255, 214, 10, 0.45)' };
    styles[lastMove.to] = { backgroundColor: 'rgba(255, 214, 10, 0.55)' };
  }
  if (chess.inCheck()) {
    const king = chess.board().flat().find((p) => p && p.type === 'k' && p.color === chess.turn());
    if (king) styles[king.square] = { background: 'radial-gradient(circle, rgba(255,0,0,0.85) 0%, rgba(255,0,0,0.35) 50%, transparent 75%)' };
  }
  return styles;
}
