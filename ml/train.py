"""
Trains the policy + value network on the shards written by prepare_data.py.

  python train.py                          # defaults: 128 channels x 10 blocks, 4 epochs
  python train.py --epochs 1 --max-positions 200000   # quick smoke test
  python train.py --init checkpoints/best.pt          # continue from earlier weights
"""

import argparse
import json
import math
import signal
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from tqdm import tqdm

from chessml.model import ChessNet

FIELDS = ("squares", "castling", "ep", "move", "wdl")
GPU_DATA_BUDGET = 2.5e9  # bytes of training data we're willing to keep on the GPU


def load_shards(paths, limit=None):
    parts = {k: [] for k in FIELDS}
    total = 0
    for path in paths:
        with np.load(path) as shard:
            for k in FIELDS:
                parts[k].append(shard[k])
            total += len(shard["move"])
        if limit and total >= limit:
            break
    data = {k: np.concatenate(v) for k, v in parts.items()}
    if limit:
        data = {k: v[:limit] for k, v in data.items()}
    return data


def to_tensors(data, device):
    return {k: torch.from_numpy(np.ascontiguousarray(v)).to(device) for k, v in data.items()}


def batch_at(data, idx, device):
    batch = {k: v[idx] for k, v in data.items()}
    if batch["move"].device != device:
        batch = {k: v.to(device, non_blocking=True) for k, v in batch.items()}
    return batch


def compute_loss(model, batch, value_weight):
    policy_logits, value_logits = model(batch["squares"], batch["castling"], batch["ep"])
    policy_loss = F.cross_entropy(policy_logits.float(), batch["move"].long())
    value_loss = F.cross_entropy(value_logits.float(), batch["wdl"].long())
    return policy_loss, value_loss, policy_logits


@torch.no_grad()
def evaluate(model, data, device, batch_size, value_weight):
    model.eval()
    n = len(data["move"])
    totals = {"policy_loss": 0.0, "value_loss": 0.0, "policy_acc": 0.0}
    for start in range(0, n, batch_size):
        idx = torch.arange(start, min(start + batch_size, n), device=data["move"].device)
        batch = batch_at(data, idx, device)
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
            policy_loss, value_loss, logits = compute_loss(model, batch, value_weight)
        k = len(idx)
        totals["policy_loss"] += policy_loss.item() * k
        totals["value_loss"] += value_loss.item() * k
        totals["policy_acc"] += (logits.argmax(1) == batch["move"].long()).float().sum().item()
    model.train()
    return {k: v / n for k, v in totals.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", default="data")
    parser.add_argument("--out", default="checkpoints")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--channels", type=int, default=128)
    parser.add_argument("--blocks", type=int, default=10)
    parser.add_argument("--max-positions", type=int, help="limit training positions (for quick tests)")
    parser.add_argument("--init", help="checkpoint to start from")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--resume", action="store_true", help="continue the interrupted run in --out")
    parser.add_argument("--fresh", action="store_true", help="start over even if --out has an unfinished run")
    parser.add_argument("--save-every", type=float, default=10, help="minutes between automatic resume saves")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    resume_path = out_dir / "last.pt"
    resume_state = None
    if args.resume:
        if not resume_path.exists():
            raise SystemExit(f"Nothing to resume: {resume_path} not found.")
        resume_state = torch.load(resume_path, map_location="cpu", weights_only=False)
        if resume_state["finished"]:
            raise SystemExit(f"The run in {out_dir}/ already finished. Use --fresh to start a new one.")
        # Continue with the original run's settings so the learning-rate schedule and data order match.
        saved = resume_state["args"]
        saved.update(data=args.data, out=args.out, save_every=args.save_every, resume=True, fresh=False)
        args = argparse.Namespace(**saved)
        print(f"Resuming from epoch {resume_state['epoch']}, step {resume_state['step']:,}")
    elif resume_path.exists() and not args.fresh:
        state = torch.load(resume_path, map_location="cpu", weights_only=False)
        if not state["finished"]:
            raise SystemExit(
                f"{out_dir}/ has an unfinished run (paused at epoch {state['epoch']}, step {state['step']:,}).\n"
                "Use --resume to continue it, or --fresh to start over (this overwrites it)."
            )

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type == "cuda":
        print(f"Training on {torch.cuda.get_device_name(0)}")
        torch.backends.cudnn.benchmark = True
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    else:
        print("WARNING: CUDA not available, training on CPU will be very slow")

    data_dir = Path(args.data)
    train_paths = sorted(data_dir.glob("train_*.npz"))
    if not train_paths:
        raise SystemExit(f"No training shards in {data_dir}/. Run prepare_data.py first.")
    train_np = load_shards(train_paths, args.max_positions)
    val_paths = sorted(data_dir.glob("val_*.npz"))
    if val_paths:
        val_np = load_shards(val_paths)
    else:  # tiny datasets may have no validation shard: hold out the last 2% instead
        cut = int(len(train_np["move"]) * 0.98)
        val_np = {k: v[cut:] for k, v in train_np.items()}
        train_np = {k: v[:cut] for k, v in train_np.items()}
    n_train = len(train_np["move"])
    bytes_needed = sum(v.nbytes for v in train_np.values())
    data_device = device if device.type == "cuda" and bytes_needed < GPU_DATA_BUDGET else torch.device("cpu")
    train = to_tensors(train_np, data_device)
    val = to_tensors(val_np, data_device)
    if data_device.type == "cpu" and device.type == "cuda":
        train = {k: v.pin_memory() for k, v in train.items()}
    del train_np, val_np
    print(f"{n_train:,} training / {len(val['move']):,} validation positions ({bytes_needed / 1e9:.2f} GB on {data_device})")

    if resume_state and resume_state["n_train"] != n_train:
        raise SystemExit(
            f"The data changed since this run started ({resume_state['n_train']:,} positions then, {n_train:,} now). "
            "Resume with the same data, or use --fresh."
        )

    model = ChessNet(args.channels, args.blocks)
    if args.init and not resume_state:
        checkpoint = torch.load(args.init, map_location="cpu")
        model = ChessNet(**checkpoint["config"])
        model.load_state_dict(checkpoint["model"])
        print(f"Initialised from {args.init}")
    model.to(device, memory_format=torch.channels_last)  # ~30% faster convolutions on tensor cores
    print(f"Model: {model.config} — {sum(p.numel() for p in model.parameters()) / 1e6:.1f}M parameters")

    decay = [p for n, p in model.named_parameters() if p.ndim > 1]
    no_decay = [p for n, p in model.named_parameters() if p.ndim <= 1]
    optimizer = torch.optim.AdamW(
        [{"params": decay, "weight_decay": args.weight_decay}, {"params": no_decay, "weight_decay": 0}], lr=args.lr
    )
    steps_per_epoch = math.ceil(n_train / args.batch_size)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr, total_steps=steps_per_epoch * args.epochs, pct_start=0.03
    )

    best_loss = float("inf")
    history = []
    start_epoch, start_step = 1, 0
    if resume_state:
        model.load_state_dict(resume_state["model"])
        optimizer.load_state_dict(resume_state["optimizer"])
        scheduler.load_state_dict(resume_state["scheduler"])
        best_loss, history = resume_state["best_loss"], resume_state["history"]
        start_epoch, start_step = resume_state["epoch"], resume_state["step"]
        torch.set_rng_state(resume_state["rng_cpu"])
        if device.type == "cuda" and resume_state.get("rng_cuda") is not None:
            torch.cuda.set_rng_state(resume_state["rng_cuda"])

    def save_resume_state(epoch, step, finished=False):
        """Everything needed to continue exactly where we left off. Written atomically."""
        state = {
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "scheduler": scheduler.state_dict(),
            "config": model.config,
            "args": vars(args),
            "epoch": epoch,
            "step": step,
            "n_train": n_train,
            "best_loss": best_loss,
            "history": history,
            "finished": finished,
            "rng_cpu": torch.get_rng_state(),
            "rng_cuda": torch.cuda.get_rng_state() if device.type == "cuda" else None,
        }
        tmp = resume_path.with_suffix(".tmp")
        torch.save(state, tmp)
        tmp.replace(resume_path)

    # Ctrl+C asks to stop; we finish the current step, save, and exit cleanly.
    stop_requested = False

    def request_stop(signum, frame):
        nonlocal stop_requested
        if stop_requested:
            raise KeyboardInterrupt  # second Ctrl+C: stop immediately
        stop_requested = True

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGBREAK"):  # Windows Ctrl+Break
        signal.signal(signal.SIGBREAK, request_stop)
    print("Press Ctrl+C to pause (progress is saved; continue later with --resume).")

    last_save = time.time()
    for epoch in range(start_epoch, args.epochs + 1):
        # The data order for each epoch depends only on the seed, so a resumed epoch sees the same batches.
        generator = torch.Generator(device=data_device).manual_seed(args.seed * 1000 + epoch)
        permutation = torch.randperm(n_train, device=data_device, generator=generator)
        first_step = start_step if epoch == start_epoch else 0
        progress = tqdm(
            range(first_step, steps_per_epoch),
            desc=f"epoch {epoch}/{args.epochs}",
            unit="step",
            initial=first_step,
            total=steps_per_epoch,
        )
        running = {"policy": 0.0, "value": 0.0, "acc": 0.0}
        started = time.time()
        for step in progress:
            if stop_requested:
                progress.close()
                save_resume_state(epoch, step)
                print(f"\nPaused at epoch {epoch}, step {step:,}. Run again with --resume to continue.")
                return
            if time.time() - last_save > args.save_every * 60:
                save_resume_state(epoch, step)
                last_save = time.time()
            idx = permutation[step * args.batch_size : (step + 1) * args.batch_size]
            batch = batch_at(train, idx, device)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                policy_loss, value_loss, logits = compute_loss(model, batch, args.value_weight)
                loss = policy_loss + args.value_weight * value_loss
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            scheduler.step()

            # Exponential moving averages for the progress bar.
            fresh = step == first_step
            running["policy"] = policy_loss.item() if fresh else 0.98 * running["policy"] + 0.02 * policy_loss.item()
            running["value"] = value_loss.item() if fresh else 0.98 * running["value"] + 0.02 * value_loss.item()
            if step % 50 == 0 or fresh:
                acc = (logits.argmax(1) == batch["move"].long()).float().mean().item()
                running["acc"] = acc if fresh else 0.9 * running["acc"] + 0.1 * acc
                pos_per_sec = (step - first_step + 1) * args.batch_size / (time.time() - started)
                progress.set_postfix(
                    policy=f"{running['policy']:.3f}",
                    value=f"{running['value']:.3f}",
                    acc=f"{running['acc']:.1%}",
                    lr=f"{scheduler.get_last_lr()[0]:.1e}",
                    pos_s=f"{pos_per_sec:,.0f}",
                )

        metrics = evaluate(model, val, device, 4096, args.value_weight)
        metrics["epoch"] = epoch
        history.append(metrics)
        print(
            f"epoch {epoch}: val policy loss {metrics['policy_loss']:.3f}, "
            f"move accuracy {metrics['policy_acc']:.1%}, value loss {metrics['value_loss']:.3f}"
        )

        checkpoint = {"model": model.state_dict(), "config": model.config, "metrics": metrics, "args": vars(args)}
        torch.save(checkpoint, out_dir / f"epoch_{epoch:02d}.pt")
        total = metrics["policy_loss"] + args.value_weight * metrics["value_loss"]
        if total < best_loss:
            best_loss = total
            torch.save(checkpoint, out_dir / "best.pt")
            print(f"  saved {out_dir / 'best.pt'}")
        (out_dir / "history.json").write_text(json.dumps(history, indent=2))
        save_resume_state(epoch + 1, 0, finished=epoch == args.epochs)
        last_save = time.time()

    print("Training finished.")


if __name__ == "__main__":
    main()
