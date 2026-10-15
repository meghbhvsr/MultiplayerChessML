"""
Exports a trained checkpoint to ONNX for the game server and checks the export matches PyTorch.

  python export_onnx.py                                  # checkpoints/best.pt -> ../server/models/chessnet.onnx
  python export_onnx.py --checkpoint checkpoints/epoch_02.pt --out ../server/models/chessnet.onnx
"""

import argparse
import json
from pathlib import Path

import chess
import numpy as np
import onnxruntime as ort
import torch

from chessml.encoding import encode_board
from chessml.model import ChessNet

TEST_FENS = [
    chess.STARTING_FEN,
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",  # en passant available
    "8/8/8/4k3/8/8/4P3/4K3 b - - 0 1",
]


def encode_batch(fens):
    encoded = [encode_board(chess.Board(f)) for f in fens]
    return (
        np.stack([e[0] for e in encoded]).astype(np.int64),
        np.stack([e[1] for e in encoded]).astype(np.float32),
        np.array([e[2] for e in encoded], dtype=np.int64),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", default="checkpoints/best.pt")
    parser.add_argument("--out", default="../server/models/chessnet.onnx")
    args = parser.parse_args()

    checkpoint = torch.load(args.checkpoint, map_location="cpu")
    model = ChessNet(**checkpoint["config"])
    model.load_state_dict(checkpoint["model"])
    model.eval()

    squares, castling, ep = encode_batch(TEST_FENS)
    inputs = (torch.from_numpy(squares), torch.from_numpy(castling), torch.from_numpy(ep))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        inputs,
        str(out),
        input_names=["squares", "castling", "ep"],
        output_names=["policy", "wdl"],
        dynamic_axes={name: {0: "batch"} for name in ["squares", "castling", "ep", "policy", "wdl"]},
        opset_version=17,
        dynamo=False,
    )

    # Verify ONNX Runtime gives the same answers as PyTorch.
    with torch.no_grad():
        torch_policy, torch_wdl = model(*inputs)
    session = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    onnx_policy, onnx_wdl = session.run(None, {"squares": squares, "castling": castling, "ep": ep})
    policy_diff = np.abs(onnx_policy - torch_policy.numpy()).max()
    wdl_diff = np.abs(onnx_wdl - torch_wdl.numpy()).max()
    print(f"max difference vs PyTorch: policy {policy_diff:.2e}, wdl {wdl_diff:.2e}")
    if max(policy_diff, wdl_diff) > 1e-3:
        raise SystemExit("ONNX output does not match PyTorch!")

    meta = {"config": checkpoint["config"], "metrics": checkpoint.get("metrics"), "checkpoint": args.checkpoint}
    out.with_suffix(".json").write_text(json.dumps(meta, indent=2))
    print(f"Exported {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
