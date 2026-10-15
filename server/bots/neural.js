import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

/**
 * Runs the network trained in ml/ (exported to ONNX by ml/export_onnx.py).
 *
 * The position encoding below must match ml/chessml/encoding.py exactly:
 *   - everything is from the side to move's point of view; for black the board is mirrored (square ^ 56)
 *   - squares: 0 empty, 1-6 own P N B R Q K, 7-12 opponent pieces (a1 = 0 ... h8 = 63)
 *   - castling: own K-side, own Q-side, opponent K-side, opponent Q-side
 *   - ep: en passant square only if an en passant capture is actually legal, else 64
 *   - moves: from * 64 + to (after mirroring)
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = process.env.NEURAL_MODEL || path.join(dir, '..', 'models', 'chessnet.onnx');
const PIECE_CODES = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const C_PUCT = 1.5;
const FPU_REDUCTION = 0.3;
const CACHE_LIMIT = 50_000;

export const neuralModelAvailable = () => fs.existsSync(MODEL_PATH);

// export_onnx.py writes <model>.json next to the model; the arena adds measured ratings to it.
// Re-exporting a model rewrites that file, so a new model starts out unmeasured.
const META_PATH = MODEL_PATH.replace(/\.onnx$/i, '') + '.json';

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Measured rating for a neural bot level, or 0 if it hasn't been measured. */
export const measuredRating = (level) => readMeta().measuredRatings?.[level]?.rating ?? 0;

export function saveMeasuredRating(level, result) {
  const meta = readMeta();
  meta.measuredRatings = { ...meta.measuredRatings, [level]: result };
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

// ---------- model loading (reloads automatically when the .onnx file is re-exported) ----------

let loading = null; // { mtimeMs, promise } — shared so concurrent first calls load the model once

function getSession() {
  const { mtimeMs } = fs.statSync(MODEL_PATH);
  if (loading?.mtimeMs !== mtimeMs) {
    const promise = (async () => {
      const ort = await import('onnxruntime-node');
      const session = await ort.InferenceSession.create(MODEL_PATH, { intraOpNumThreads: 2 });
      cache.clear();
      console.log(`Loaded neural model ${MODEL_PATH}`);
      return { ort, session };
    })();
    loading = { mtimeMs, promise };
    promise.catch(() => {
      if (loading?.promise === promise) loading = null; // retry on the next call
    });
  }
  return loading.promise;
}

// ---------- encoding ----------

const squareIndex = (name) => name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * 8;

export function encode(fen, legalMoves) {
  const [placement, turn, castlingField, epField] = fen.split(' ');
  const flip = turn === 'b';
  const squares = new BigInt64Array(64);
  placement.split('/').forEach((row, r) => {
    const rank = 7 - r;
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const isWhite = ch === ch.toUpperCase();
      const own = isWhite === (turn === 'w');
      let sq = rank * 8 + file;
      if (flip) sq ^= 56;
      squares[sq] = BigInt(PIECE_CODES[ch.toLowerCase()] + (own ? 0 : 6));
      file++;
    }
  });

  const rights = turn === 'w' ? ['K', 'Q', 'k', 'q'] : ['k', 'q', 'K', 'Q'];
  const castling = Float32Array.from(rights.map((c) => (castlingField.includes(c) ? 1 : 0)));

  let ep = 64;
  if (epField !== '-' && legalMoves.some((m) => m.flags.includes('e'))) {
    ep = squareIndex(epField);
    if (flip) ep ^= 56;
  }
  return { squares, castling, ep: BigInt64Array.of(BigInt(ep)), flip };
}

export function moveIndex(move, flip) {
  let from = squareIndex(move.from);
  let to = squareIndex(move.to);
  if (flip) {
    from ^= 56;
    to ^= 56;
  }
  return from * 64 + to;
}

// ---------- evaluation ----------

const cache = new Map(); // fen -> { moves, priors, value }

/**
 * Evaluates a position: legal moves (promotions only to queen) with prior probabilities, and a value
 * in [-1, 1] from the side to move's perspective (P(win) - P(loss)).
 */
async function evaluate(fen) {
  const hit = cache.get(fen);
  if (hit) return hit;

  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true }).filter((m) => !m.promotion || m.promotion === 'q');
  let result;
  if (moves.length === 0) {
    result = { moves, priors: [], value: chess.isCheckmate() ? -1 : 0, terminal: true };
  } else if (chess.isDraw()) {
    result = { moves: [], priors: [], value: 0, terminal: true };
  } else {
    const { ort, session } = await getSession();
    const { squares, castling, ep, flip } = encode(fen, moves);
    const output = await session.run({
      squares: new ort.Tensor('int64', squares, [1, 64]),
      castling: new ort.Tensor('float32', castling, [1, 4]),
      ep: new ort.Tensor('int64', ep, [1]),
    });
    const logits = output.policy.data;
    const raw = moves.map((m) => logits[moveIndex(m, flip)]);
    const max = Math.max(...raw);
    const exps = raw.map((x) => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const [w, d, l] = softmax(Array.from(output.wdl.data));
    result = { moves, priors: exps.map((e) => e / sum), value: w - l, wdl: [w, d, l] };
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(fen, result);
  return result;
}

function softmax(xs) {
  const max = Math.max(...xs);
  const exps = xs.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

const uci = (m) => m.from + m.to + (m.promotion ?? '');

// ---------- move selection ----------

/** Plays straight from the network's policy. temperature 0 = always the top move. */
async function policyMove(fen, temperature = 0) {
  const { moves, priors } = await evaluate(fen);
  if (!moves.length) throw new Error('No legal moves');
  if (!temperature) return uci(moves[priors.indexOf(Math.max(...priors))]);
  const weights = priors.map((p) => p ** (1 / temperature));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < moves.length; i++) if ((r -= weights[i]) <= 0) return uci(moves[i]);
  return uci(moves.at(-1));
}

/**
 * Monte Carlo tree search guided by the network (PUCT, as in AlphaZero).
 * Each node's W/N is the average value from the perspective of the player who moved into it.
 */
class Node {
  constructor(move, prior) {
    this.move = move;
    this.prior = prior;
    this.N = 0;
    this.W = 0;
    this.children = null;
  }
}

async function expand(node, fen) {
  const { moves, priors, value, terminal } = await evaluate(fen);
  node.children = terminal ? [] : moves.map((m, i) => new Node(m, priors[i]));
  return value;
}

function selectChild(node) {
  const sqrtN = Math.sqrt(node.N);
  const parentQ = node.N ? -node.W / node.N : 0; // parent's value for its own side to move
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children) {
    const q = child.N ? child.W / child.N : parentQ - FPU_REDUCTION;
    const score = q + (C_PUCT * child.prior * sqrtN) / (1 + child.N);
    if (score > bestScore) {
      bestScore = score;
      best = child;
    }
  }
  return best;
}

async function searchMove(fen, { nodes = 400, movetime = 3000 }) {
  const root = new Node(null, 1);
  await expand(root, fen);
  if (!root.children.length) throw new Error('No legal moves');
  if (root.children.length === 1) return uci(root.children[0].move);

  const chess = new Chess(fen);
  const deadline = Date.now() + movetime;
  for (let i = 0; i < nodes && Date.now() < deadline; i++) {
    const path = [root];
    let node = root;
    while (node.children?.length) {
      node = selectChild(node);
      chess.move({ from: node.move.from, to: node.move.to, promotion: node.move.promotion });
      path.push(node);
    }
    // Leaf: evaluate (expanding it) unless it's a known terminal position.
    let value = node.children ? (await evaluate(chess.fen())).value : await expand(node, chess.fen());
    for (let j = 1; j < path.length; j++) chess.undo();

    // Back up: the leaf's value is for its side to move, i.e. the opponent of whoever moved into it.
    value = -value;
    for (let j = path.length - 1; j >= 0; j--) {
      path[j].N++;
      path[j].W += value;
      value = -value;
    }
  }

  const best = root.children.reduce((a, b) => (b.N > a.N ? b : a));
  return uci(best.move);
}

/** Entry point used by bots/index.js. */
export async function neuralMove(fen, { search, nodes, movetime, temperature }) {
  return search ? searchMove(fen, { nodes, movetime }) : policyMove(fen, temperature);
}
