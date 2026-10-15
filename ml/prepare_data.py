"""
Builds training data from the Lichess game database.

Streams a monthly dump straight from database.lichess.org (decompressing on the fly, so the 30+ GB file
never touches your disk), keeps games between strong players, and writes every position as
(board, move played, game result) into compact .npz shards.

Examples:
  python prepare_data.py --month 2025-01 --games 300000
  python prepare_data.py --pgn my_games.pgn.zst --games 1000
"""

import argparse
import io
import json
import re
import time
from collections import deque
from multiprocessing import Pool, cpu_count
from pathlib import Path

import chess
import numpy as np
import zstandard
from tqdm import tqdm

from chessml.encoding import encode_board, encode_move

LICHESS_URL = "https://database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst"
HEADER_RE = re.compile(r'\[(\w+) "(.*)"\]')
COMMENT_RE = re.compile(r"\{[^}]*\}")
SKIP_TOKEN_RE = re.compile(r"\d+\.+|\$\d+|1-0|0-1|1/2-1/2|\*")
WHITE_SCORE = {"1-0": 1, "1/2-1/2": 0, "0-1": -1}
BATCH_GAMES = 256
VAL_EVERY = 50  # every 50th batch (~2% of games) goes to the validation set


def open_stream(args):
    if args.pgn:
        raw = open(args.pgn, "rb")
        source = args.pgn
    else:
        import requests

        source = LICHESS_URL.format(month=args.month)
        response = requests.get(source, stream=True, timeout=60)
        response.raise_for_status()
        raw = response.raw
    if source.endswith(".zst"):
        raw = zstandard.ZstdDecompressor().stream_reader(raw, read_size=1 << 20)
    return source, io.TextIOWrapper(raw, encoding="utf-8", errors="replace")


def iter_games(lines):
    """Yields (headers, movetext) for each game in a PGN text stream."""
    headers, movetext = {}, []
    for line in lines:
        if line.startswith("[Event ") and headers:
            if movetext:
                yield headers, "".join(movetext)
            headers, movetext = {}, []
        if line.startswith("["):
            match = HEADER_RE.match(line)
            if match:
                headers[match.group(1)] = match.group(2)
        elif line.strip():
            movetext.append(line)
    if headers and movetext:
        yield headers, "".join(movetext)


def keep_game(headers, args):
    if headers.get("Result") not in WHITE_SCORE or headers.get("Termination") != "Normal":
        return False  # skip time forfeits and abandoned games
    try:
        if min(int(headers["WhiteElo"]), int(headers["BlackElo"])) < args.min_elo:
            return False
        base, increment = headers.get("TimeControl", "-").split("+")
        return int(base) + 40 * int(increment) >= args.min_time  # Lichess' estimated game duration
    except (KeyError, ValueError):
        return False


def parse_batch(games):
    """Worker: turns a list of (result, movetext) into position arrays."""
    squares, castling, ep, moves, wdl = [], [], [], [], []
    for result, movetext in games:
        board = chess.Board()
        white_score = WHITE_SCORE[result]
        try:
            for token in COMMENT_RE.sub(" ", movetext).split():
                if SKIP_TOKEN_RE.fullmatch(token):
                    continue
                move = board.parse_san(token.rstrip("!?"))
                sq, ca, e = encode_board(board)
                score = white_score if board.turn == chess.WHITE else -white_score
                squares.append(sq)
                castling.append(ca)
                ep.append(e)
                moves.append(encode_move(move, board.turn))
                wdl.append(1 - score)  # 0 = win, 1 = draw, 2 = loss for the side to move
                board.push(move)
        except ValueError:
            continue  # malformed game: positions already added are still valid
    if not moves:
        return None
    return {
        "squares": np.stack(squares),
        "castling": np.stack(castling),
        "ep": np.array(ep, dtype=np.int8),
        "move": np.array(moves, dtype=np.int16),
        "wdl": np.array(wdl, dtype=np.int8),
    }


class ShardWriter:
    def __init__(self, out_dir: Path, prefix: str, shard_size: int):
        self.out_dir, self.prefix, self.shard_size = out_dir, prefix, shard_size
        self.parts, self.count, self.index, self.total = [], 0, 0, 0

    def add(self, part):
        self.parts.append(part)
        self.count += len(part["move"])
        if self.count >= self.shard_size:
            self.flush()

    def flush(self):
        if not self.parts:
            return
        merged = {k: np.concatenate([p[k] for p in self.parts]) for k in self.parts[0]}
        np.savez(self.out_dir / f"{self.prefix}_{self.index:03d}.npz", **merged)
        self.total += self.count
        self.parts, self.count = [], 0
        self.index += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--month", default="2025-01", help="Lichess database month, YYYY-MM")
    parser.add_argument("--pgn", help="use a local .pgn or .pgn.zst file instead of downloading")
    parser.add_argument("--games", type=int, default=300_000, help="number of games to keep")
    parser.add_argument("--min-elo", type=int, default=2000, help="both players must be rated at least this")
    parser.add_argument("--min-time", type=int, default=180, help="minimum estimated game length in seconds (180 = blitz)")
    parser.add_argument("--out", default="data")
    parser.add_argument("--shard-size", type=int, default=2_000_000, help="positions per output file")
    parser.add_argument("--workers", type=int, default=max(1, cpu_count() - 2))
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.npz"):
        old.unlink()
    train = ShardWriter(out_dir, "train", args.shard_size)
    val = ShardWriter(out_dir, "val", 10**12)  # single file

    source, lines = open_stream(args)
    print(f"Reading {source}")
    print(f"Keeping games with both players >= {args.min_elo} and est. length >= {args.min_time}s, using {args.workers} workers")

    started = time.time()
    scanned = kept = batches = 0
    batch = []
    progress = tqdm(total=args.games, unit="game", smoothing=0.05)

    with Pool(args.workers) as pool:
        pending = deque()

        def collect(result_handle):
            part, is_val = result_handle[0].get(), result_handle[1]
            if part is not None:
                (val if is_val else train).add(part)

        def submit(games):
            nonlocal batches
            pending.append((pool.apply_async(parse_batch, (games,)), batches % VAL_EVERY == VAL_EVERY - 1))
            batches += 1
            while len(pending) >= args.workers * 2:  # bound memory: don't read ahead of the workers
                collect(pending.popleft())

        try:
            for headers, movetext in iter_games(lines):
                scanned += 1
                if keep_game(headers, args):
                    batch.append((headers["Result"], movetext))
                    kept += 1
                    progress.update(1)
                    if scanned % 1000 == 0 or kept % 1000 == 0:
                        progress.set_postfix(scanned=f"{scanned:,}", positions=f"{train.total + train.count:,}")
                    if len(batch) == BATCH_GAMES:
                        submit(batch)
                        batch = []
                    if kept >= args.games:
                        break
        except KeyboardInterrupt:
            print("\nInterrupted: saving what has been processed so far.")
        if batch:
            submit(batch)
        while pending:
            collect(pending.popleft())

    progress.close()
    train.flush()
    val.flush()
    info = {
        "source": source,
        "games_scanned": scanned,
        "games_kept": kept,
        "train_positions": train.total,
        "val_positions": val.total,
        "min_elo": args.min_elo,
        "min_time": args.min_time,
        "seconds": round(time.time() - started),
    }
    (out_dir / "info.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
