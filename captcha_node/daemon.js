/**
 * Captcha daemon — bounded concurrency queue.
 *
 * Modes (ZCODE_CAPTCHA_BROWSER_POOL):
 *   unset/1 — long-lived worker pool (one Chromium per worker, context per solve) [default]
 *   0       — child-process per solve (full browser launch each time)
 */
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');

const NODE_BIN = process.env.ZCODE_NODE_PATH?.trim() || 'node';
const SOLVER_JS = path.join(__dirname, 'solver.js');
const WORKER_JS = path.join(__dirname, 'worker.js');
const USE_POOL = process.env.ZCODE_CAPTCHA_BROWSER_POOL !== '0';
const MAX_CONCURRENT = Math.max(
	1,
	Number(
		process.env.CAPTCHA_DAEMON_CONCURRENCY ??
			(process.env.ZCODE_CAPTCHA_LOW_CPU === "1" ? 3 : 6),
	),
);
const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT || 40) * 1000;
// Lazy pool: workers spawn on demand (no pre-spawn) and idle workers are
// reaped after IDLE_MS with nothing queued — RAM drops to ~1 worker at zero
// traffic instead of MAX_CONCURRENT permanent Chromium processes.
const WORKER_IDLE_REAP_MS = Number(process.env.ZCODE_CAPTCHA_WORKER_IDLE_MS || 120) * 1000;
const WORKER_WARM_FLOOR = Number(process.env.ZCODE_CAPTCHA_WORKER_WARM_FLOOR ?? 1);

const queue = [];
let active = 0;

/** @type {Array<{ proc: import('node:child_process').ChildProcess, busy: boolean, buffer: string, ready: boolean, reqId: number | null, timer: ReturnType<typeof setTimeout> | null }>} */
const workers = [];

function runSolveChild(req) {
  const scene = req.scene || '11xygtvd';
  const region = req.region || 'sgp';
  const prefix = req.prefix || 'no8xfe';

  return new Promise((resolve) => {
    const proc = spawn(NODE_BIN, [SOLVER_JS, scene, region, prefix], {
      cwd: __dirname,
      env: { ...process.env, FONTCONFIG_PATH: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      resolve({ id: req.id, ok: false, error: `child solve timeout (${SOLVE_TIMEOUT_MS}ms)` });
    }, SOLVE_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ id: req.id, ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        for (const line of stdout.split(/\r?\n/)) {
          if (line.startsWith('VERIFY_PARAM=')) {
            const param = line.slice('VERIFY_PARAM='.length).trim();
            if (param.length > 20) {
              resolve({ id: req.id, ok: true, param });
              return;
            }
          }
        }
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? '?'}`;
      resolve({ id: req.id, ok: false, error: detail.slice(0, 300) });
    });
  });
}

function spawnWorker() {
  const entry = {
    proc: null,
    busy: false,
    buffer: '',
    ready: false,
    reqId: null,
    timer: null,
    reaping: false,
  };
  const proc = spawn(NODE_BIN, [WORKER_JS], {
    cwd: __dirname,
    env: { ...process.env, FONTCONFIG_PATH: '/dev/null' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  entry.proc = proc;

  proc.stdout?.on('data', (chunk) => {
    entry.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, idx).trim();
      entry.buffer = entry.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.workerReady) {
          entry.ready = true;
          drainQueue();
          continue;
        }
        if (typeof msg.id === 'number' && entry.reqId === msg.id) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.busy = false;
          entry.reqId = null;
          entry.timer = null;
          process.stdout.write(JSON.stringify(msg) + '\n');
          active -= 1;
          drainQueue();
          scheduleReap();
        }
      } catch (_) {}
    }
  });

  proc.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) process.stderr.write(`[worker] ${text}\n`);
  });

  proc.on('close', () => {
    const i = workers.indexOf(entry);
    if (i >= 0) workers.splice(i, 1);
    if (entry.reqId != null) {
      if (entry.timer) clearTimeout(entry.timer);
      process.stdout.write(
        JSON.stringify({ id: entry.reqId, ok: false, error: 'worker died mid-solve' }) + '\n',
      );
      active -= 1;
    }
    // Respawn to keep pool size only if workers are needed: a death while
    // requests are queued (or under the warm floor) refills; intentional
    // idle reaps (entry.reaping, idle system) do not respawn.
    if (USE_POOL && !entry.reaping) {
      if (queue.length > 0 || active > 0 || workers.length < WORKER_WARM_FLOOR) {
        workers.push(spawnWorker());
      }
    }
    drainQueue();
  });

  workers.push(entry);
  return entry;
}

function initPool() {
  // Lazy: no pre-spawn. Workers appear on demand from drainQueue().
  workers.length = 0;
}

function reapIdleWorkers() {
  if (queue.length > 0 || active > 0) return;
  const idle = workers.filter(
    (x) => x.ready && !x.busy && x.reqId == null && x.proc && !x.reaping,
  );
  // Keep WORKER_WARM_FLOOR warm to avoid cold-start latency on the next token.
  const excess = idle.slice(Math.max(0, WORKER_WARM_FLOOR));
  for (const w of excess) {
    w.reaping = true;
    try {
      w.proc.kill('SIGTERM');
    } catch (_) {}
  }
}

let reapTimer = null;
function scheduleReap() {
  if (reapTimer) return;
  reapTimer = setTimeout(() => {
    reapTimer = null;
    reapIdleWorkers();
    if (workers.length > 0 || queue.length > 0) scheduleReap();
  }, WORKER_IDLE_REAP_MS);
  reapTimer.unref?.();
}

function drainQueue() {
  while (queue.length > 0 && active < MAX_CONCURRENT) {
    const req = queue.shift();
    active += 1;

    if (USE_POOL) {
      let w = workers.find((x) => x.ready && !x.busy && x.proc?.stdin?.writable);
      if (!w && workers.length < MAX_CONCURRENT) {
        // On-demand spawn: grow the pool only when requests are waiting.
        w = spawnWorker();
      }
      if (!w) {
        queue.unshift(req);
        active -= 1;
        break;
      }
      w.busy = true;
      w.reqId = req.id;
      w.timer = setTimeout(() => {
        try {
          w.proc?.kill('SIGKILL');
        } catch (_) {}
        w.busy = false;
        w.reqId = null;
        w.timer = null;
        process.stdout.write(
          JSON.stringify({ id: req.id, ok: false, error: `worker solve timeout (${SOLVE_TIMEOUT_MS}ms)` }) + '\n',
        );
        active -= 1;
        drainQueue();
      }, SOLVE_TIMEOUT_MS);
      w.proc.stdin.write(JSON.stringify(req) + '\n');
    } else {
      void runSolveChild(req)
        .then((result) => {
          process.stdout.write(JSON.stringify(result) + '\n');
        })
        .finally(() => {
          active -= 1;
          drainQueue();
        });
    }
  }
}

function enqueue(req) {
  queue.push(req);
  drainQueue();
}

function main() {
  if (USE_POOL) initPool();

  process.stdout.write(
    JSON.stringify({
      ready: true,
      concurrency: MAX_CONCURRENT,
      mode: USE_POOL ? 'browser-pool' : 'child-process',
    }) + '\n',
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'invalid json' }) + '\n');
      return;
    }
    if (typeof req.id !== 'number') {
      process.stdout.write(JSON.stringify({ id: req.id ?? null, ok: false, error: 'missing id' }) + '\n');
      return;
    }
    enqueue(req);
  });
}

main();
