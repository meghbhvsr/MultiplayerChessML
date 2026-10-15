"""
Shows what a trained network thinks of a position: its top moves and win/draw/loss estimate.

  python predict.py
  python predict.py "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
"""

import argparse

import chess
import numpy as np
import torch

from chessml.encoding import decode_move, encode_board, legal_move_mask
from chessml.model import ChessNet


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("fen", nargs="?", default=chess.STARTING_FEN)
    parser.add_argument("--checkpoint", default="checkpoints/best.pt")
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location="cpu")
    model = ChessNet(**checkpoint["config"])
    model.load_state_dict(checkpoint["model"])
    model.eval()

    board = chess.Board(args.fen)
    squares, castling, ep = encode_board(board)
    with torch.no_grad():
        policy, wdl = model(
            torch.from_numpy(squares).long()[None], torch.from_numpy(castling).float()[None], torch.tensor([ep])
        )
    logits = policy[0].numpy()
    logits[~legal_move_mask(board)] = -np.inf
    probs = np.exp(logits - logits.max())
    probs /= probs.sum()
    win, draw, loss = torch.softmax(wdl[0], 0).tolist()

    print(board, "\n")
    print(f"{'White' if board.turn else 'Black'} to move — win {win:.0%}, draw {draw:.0%}, loss {loss:.0%}")
    for index in np.argsort(-probs)[: args.top]:
        print(f"  {board.san(decode_move(int(index), board)):8} {probs[index]:.1%}")


if __name__ == "__main__":
    main()
