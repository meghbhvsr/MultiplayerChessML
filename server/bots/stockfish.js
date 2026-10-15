import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const POOL_SIZE = Number(process.env.BOT_ENGINES) || 2;

/**
 * Uses the WASM build from the `stockfish` npm package, run as a child process so searches never
 * block the game server. Set STOCKFISH_PATH to a native stockfish binary for a stronger engine.
 */
function engineCommand() {
  if (process.env.STOCKFISH_PATH) return [process.env.STOCKFISH_PATH, []];
  const pkgDir = path.dirname(require.resolve('stockfish/package.json'));
  return [process.execPath, [path.join(pkgDir, 'bin', 'stockfish-18-lite-single.js')]];
}

/** One engine process speaking UCI over stdin/stdout. Handles one search at a time. */
class UciEngine {
  constructor() {
    const [cmd, args] = engineCommand();
    this.alive = true;
    this.onLine = null;
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc.stdin.on('error', () => {});
    this.proc.on('exit', () => {
      this.alive = false;
      this.onLine?.(null);
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine?.(line));
    this.send('uci');
  }

  send(cmd) {
    if (this.alive) this.proc.stdin.write(cmd + '\n');
  }

  /** Resolves with the first output line starting with `prefix`. */
  waitFor(prefix, timeoutMs) {
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        clearTimeout(timer);
        this.onLine = null;
        fn(value);
      };
      const timer = setTimeout(() => done(reject, new Error(`Engine timed out waiting for ${prefix}`)), timeoutMs);
      this.onLine = (line) => {
        if (line === null) done(reject, new Error('Engine exited'));
        else if (line.startsWith(prefix)) done(resolve, line);
      };
    });
  }

  /** Returns the best move in UCI notation, e.g. "e2e4" or "e7e8q". */
  async bestMove(fen, { skill = 20, depth, movetime }) {
    this.send(`setoption name Skill Level value ${skill}`);
    this.send('isready');
    await this.waitFor('readyok', 30_000); // generous: the first call includes engine startup
    this.send(`position fen ${fen}`);
    this.send(['go', depth && `depth ${depth}`, movetime && `movetime ${movetime}`].filter(Boolean).join(' '));
    const line = await this.waitFor('bestmove', (movetime ?? 5_000) + 20_000);
    const move = line.split(/\s+/)[1];
    if (!move || move === '(none)') throw new Error('Engine returned no move');
    return move;
  }

  kill() {
    this.alive = false;
    this.proc.kill();
  }
}

// ---------- a small pool so several bot games can think at once ----------

const all = new Set();
const idle = [];
const waiting = [];

function spawnEngine() {
  const engine = new UciEngine();
  all.add(engine);
  return engine;
}

function acquire() {
  const engine = idle.pop();
  if (engine) return engine;
  if (all.size < POOL_SIZE) return spawnEngine();
  return new Promise((resolve) => waiting.push(resolve));
}

function release(engine) {
  if (!engine.alive) {
    all.delete(engine);
    if (waiting.length) waiting.shift()(spawnEngine());
    return;
  }
  if (waiting.length) waiting.shift()(engine);
  else idle.push(engine);
}

export async function stockfishMove(fen, options) {
  const engine = await acquire();
  try {
    return await engine.bestMove(fen, options);
  } catch (err) {
    engine.kill(); // a stuck or crashed engine is replaced on the next request
    throw err;
  } finally {
    release(engine);
  }
}

export function shutdownEngines() {
  for (const engine of all) engine.kill();
  all.clear();
  idle.length = 0;
}

// On Windows, child processes outlive their parent, so kill engines explicitly on shutdown.
process.on('exit', shutdownEngines);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => process.exit());
}
