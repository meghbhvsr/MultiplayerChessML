"""
Position and move encoding shared by data prep, training and export.

Everything is from the point of view of the side to move: when black is to move the board is
mirrored vertically (square ^ 56), so the network always "plays white". The JavaScript bot in
server/bots/neural.js implements exactly the same encoding; keep the two in sync.

Position:
  squares  int8[64]  0 = empty, 1-6 = own P N B R Q K, 7-12 = opponent P N B R Q K (a1 = 0 ... h8 = 63)
  castling int8[4]   own kingside, own queenside, opponent kingside, opponent queenside
  ep       int8      en passant target square, or 64 if no legal en passant capture exists

Move:
  from_square * 64 + to_square (4096 classes, after mirroring). Promotions share the index of the
  plain from-to move and are played as queen promotions.

Value target (WDL from the side to move): 0 = win, 1 = draw, 2 = loss.
"""

import chess
import numpy as np

NUM_MOVES = 64 * 64
NO_EP = 64

_PIECE_CODE = {chess.PAWN: 1, chess.KNIGHT: 2, chess.BISHOP: 3, chess.ROOK: 4, chess.QUEEN: 5, chess.KING: 6}


def encode_board(board: chess.Board):
    us = board.turn
    flip = us == chess.BLACK
    squares = np.zeros(64, dtype=np.int8)
    for square, piece in board.piece_map().items():
        index = square ^ 56 if flip else square
        squares[index] = _PIECE_CODE[piece.piece_type] + (0 if piece.color == us else 6)

    them = not us
    castling = np.array(
        [
            board.has_kingside_castling_rights(us),
            board.has_queenside_castling_rights(us),
            board.has_kingside_castling_rights(them),
            board.has_queenside_castling_rights(them),
        ],
        dtype=np.int8,
    )

    ep = NO_EP
    if board.ep_square is not None and board.has_legal_en_passant():
        ep = board.ep_square ^ 56 if flip else board.ep_square
    return squares, castling, ep


def encode_move(move: chess.Move, turn: chess.Color) -> int:
    from_sq, to_sq = move.from_square, move.to_square
    if turn == chess.BLACK:
        from_sq, to_sq = from_sq ^ 56, to_sq ^ 56
    return from_sq * 64 + to_sq


def decode_move(index: int, board: chess.Board) -> chess.Move:
    from_sq, to_sq = divmod(index, 64)
    if board.turn == chess.BLACK:
        from_sq, to_sq = from_sq ^ 56, to_sq ^ 56
    move = chess.Move(from_sq, to_sq)
    piece = board.piece_at(from_sq)
    if piece and piece.piece_type == chess.PAWN and chess.square_rank(to_sq) in (0, 7):
        move.promotion = chess.QUEEN
    return move


def legal_move_mask(board: chess.Board) -> np.ndarray:
    mask = np.zeros(NUM_MOVES, dtype=bool)
    for move in board.legal_moves:
        mask[encode_move(move, board.turn)] = True
    return mask
