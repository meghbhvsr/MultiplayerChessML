# Training your own chess AI

A neural network that learns chess from millions of positions played by strong humans on Lichess
(supervised learning), then plays in the game as **NeuralNet Instinct** and **NeuralNet Search**.

```
Lichess games ──► prepare_data.py ──► data/*.npz ──► train.py ──► checkpoints/best.pt
                                                                          │
                       server/models/chessnet.onnx ◄── export_onnx.py ◄───┘
                                  │
                                  ▼
                   server/bots/neural.js  (policy move, or MCTS search)
```

## The model

- **Input:** the board from the side to move's point of view (12 piece planes + castling + en passant).
- **Body:** a residual CNN (default 10 blocks × 128 channels, ~12M parameters), like AlphaZero/Leela.
- **Policy head:** a probability for each of the 4096 from→to moves, trained to predict the move the strong player chose.
- **Value head:** win/draw/loss for the side to move, trained on the final game result.

In the game, **Instinct** plays the policy's top move without calculating. **Search** runs Monte Carlo
tree search (PUCT, as in AlphaZero): the policy decides which moves to look at, and the value judges the
resulting positions. Search is usually several hundred Elo stronger.

## Setup (once)

From the `ml/` folder in PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install torch==2.7.1 --index-url https://download.pytorch.org/whl/cu126
.venv\Scripts\python -m pip install -r requirements.txt
```

## 1. Build the dataset

```powershell
.venv\Scripts\python prepare_data.py --month 2025-01 --games 300000
```

This **streams** the month's Lichess database (a 30 GB file) and decompresses it on the fly, so it never
lands on your disk. It keeps only games where both players are rated 2000+ and the time control is blitz or
slower, finished normally (no time forfeits). About 1 in 19 games qualifies, so 300k games means reading
~6M games; that takes roughly 5–15 minutes depending on your connection. 300k games ≈ 22M positions ≈ 1.6 GB
on disk. Ctrl+C stops early and keeps what's done.

Knobs: `--min-elo 2200` (stronger but fewer games), `--games 500000` (more data, better model).
More data helps up to the GPU memory limit: about 30M positions fit on an 8 GB card.

## 2. Train

```powershell
.venv\Scripts\python train.py
```

Defaults: 4 epochs, batch 1024, AdamW with a one-cycle learning rate, bfloat16 mixed precision.
An RTX 3060 Ti trains about 12,000 positions/second, so with 25M positions each epoch takes ~35 minutes
and the full run ~2.5 hours. It saves
`checkpoints/epoch_NN.pt` after each epoch and `checkpoints/best.pt` when validation improves.

### Pausing and resuming

- **Pause:** press **Ctrl+C** (or Ctrl+Break). It finishes the current batch, saves, and exits. Press it twice to quit
  immediately without saving.
- **Resume:** `.venv\Scripts\python train.py --resume` continues from the exact step, mid-epoch, with the same
  learning-rate schedule and data order, as if it never stopped. It reuses the original run's settings.
- **Crashes and reboots:** progress is autosaved every 10 minutes (`--save-every 5` to change), so `--resume`
  loses at most that much.
- **Starting over:** if `checkpoints/` has an unfinished run, `train.py` refuses to overwrite it. Use `--fresh` to
  start a new run anyway, or `--out checkpoints2` to keep both.

Resume needs the same dataset; don't re-run `prepare_data.py` in between.

What the numbers mean:
- **move accuracy:** how often it predicts the human's exact move. 40–50% is good; it's below 100%
  because strong players disagree on equally good moves.
- **policy loss:** should drop from ~8.3 (random) to around 1.7–1.9.
- **value loss:** win/draw/loss cross-entropy; ~0.85–0.95 is typical (results are noisy).

Quick sanity check without the full data: `train.py --epochs 1 --max-positions 200000`.

## 3. Look at what it learned

```powershell
.venv\Scripts\python predict.py
.venv\Scripts\python predict.py "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
```

## 4. Put it in the game

```powershell
.venv\Scripts\python export_onnx.py
```

This writes `server/models/chessnet.onnx` and checks that ONNX Runtime gives the same outputs as PyTorch.
The server picks up the new model on the next bot move (no restart), and the **🧠 Your AI** buttons in
"Play vs computer" unlock.

## 5. Measure its rating

From the project root:

```powershell
npm.cmd run arena                                  # NeuralNet Search vs Stockfish Lv4, 5, 6 — 16 games each (~30 min)
npm.cmd run arena -- --bot 9 --vs "2,3,4"           # NeuralNet Instinct
npm.cmd run arena -- --vs "5,6,7" --games 24       # stronger opponents, more games = narrower range
```

In PowerShell use `npm.cmd` (not `npm`) and quote lists like `"5,6,7"`: PowerShell's `npm` wrapper drops the `--`,
so the options go to npm instead of the arena (you just see npm's version number). Alternatively run
`node scripts/arena.js --vs "5,6,7"` from the `server` folder.

Each opening is played twice with colors swapped. It prints W/D/L per opponent and an estimated rating with a
95% range, saves the games as PGN in `server/arena/`, and the app shows the measured rating instead of "?".
Pick opponents around its strength: if it wins or loses nearly everything, the estimate isn't informative.
The number is anchored to the Stockfish levels' estimated ratings, so it's approximate; **comparing two runs
(before vs after a change) is the reliable part**. Re-exporting a model resets its rating to "?".

## Making it stronger

1. **More and better data.** Use more games (`--games 1000000` over a few months), or raise `--min-elo`.
2. **A bigger network.** `--blocks 15 --channels 192` is stronger, but training and search are slower.
3. **Better value labels.** Lichess publishes ~200M positions with Stockfish evaluations
   (`database.lichess.org/#evals`). Training the value head on those instead of game results makes the
   search much sharper.
4. **More search.** Raise `nodes` for NeuralNet Search in `server/bots/index.js` (it's slower per move).
5. **Self-play / reinforcement learning.** Once it's decent, let it play itself with search, and train on
   those games (the AlphaZero loop). This needs lots of games, so it's the last step.

Measure each change by playing it against the Stockfish levels.
