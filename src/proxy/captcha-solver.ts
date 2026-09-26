/**
 * Solver backend dispatch -- fork patch: out-of-thread solving.
 *
 * Backend (ZCODE_CAPTCHA_BACKEND): "happy" (default) -- the happy-dom solver
 * in src/proxy/captcha-happy.ts.
 *
 * Fork change: the solver runs in a worker_threads Worker instead of on the
 * main thread. In-process solving froze the proxy's event loop via
 * Atomics.wait sync XHRs (each up to 30s), so a burst of parallel solves
 * stalled EVERY connection -- the "thinking for minutes after idle" failure.
 * Worker solving also isolates happy-dom's global browser-frame/cookie state
 * per solve (one Worker per solve, terminated after), removing cross-solve
 * races the in-process path suffered under parallel waves.
 *
 * Bundling: `bun build --compile` cannot resolve `new Worker(new URL(...))`
 * at runtime (module paths don't exist in the single-file binary), so the
 * worker entry is imported as a build-time FILE ASSET
 * (`import entryPath from "./captcha-worker-entry.ts" with { type: "file" }`)
 * and extracted to a temp path by the compiled runtime. Verified working in
 * compiled exes on Bun 1.4; plain `bun run` resolves the same asset import.
 */
import { Worker } from "node:worker_threads";
// Asset import: embeds the PRE-BUNDLED worker (plain JS, self-contained ESM --
// built by scripts/build-fork-worker.ts before compilation; raw .ts assets
// are not parsed by the compiled runtime). @ts-expect-error -- Bun's
// `with { type: "file" }` asset import has no DOM-lib type declaration; the
// default export is the extracted file path at runtime.
// @ts-expect-error asset import
import captchaWorkerEntryPath from "./captcha-worker-entry.bundle.js" with { type: "file" };

const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";

/** Per-solve timeout: overall deadline the worker gets before termination. */
const SOLVE_WORKER_TIMEOUT_MS = Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS || 20_000);

interface SolveRequest {
  id: number;
  scene: string;
  region: string;
  prefix: string;
}
type SolveResponse = { id: number; ok: true; param: string } | { id: number; ok: false; error: string };

let nextSolveId = 0;

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    throw new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`);
  }
  return solveInWorker({ scene, region, prefix });
}

/**
 * One solve = one Worker. Startup cost is a few ms (happy-dom loads lazily
 * inside the entry on first message); termination guarantees no state leaks
 * between solves. A hung solve cannot wedge anything: the pool's takeToken
 * race deadline (25s) fires first, and the worker is force-terminated here.
 */
function solveInWorker(req: { scene: string; region: string; prefix: string }): Promise<string> {
  const id = ++nextSolveId;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let worker: Worker | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker?.terminate(); } catch {}
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`captcha worker timeout (${SOLVE_WORKER_TIMEOUT_MS}ms)`)));
    }, SOLVE_WORKER_TIMEOUT_MS);

    try {
      worker = new Worker(captchaWorkerEntryPath);
    } catch (err) {
      settle(() => reject(new Error(`captcha worker spawn failed: ${(err as Error).message}`)));
      return;
    }
    const msg: SolveRequest = { id, ...req };
    worker.on("message", (m: SolveResponse) => {
      if (!m || m.id !== id) return;
      if (m.ok) settle(() => resolve(m.param));
      else settle(() => reject(new Error(m.error)));
    });
    worker.on("error", (err: Error) => {
      settle(() => reject(new Error(`captcha worker error: ${err.message}`)));
    });
    worker.on("exit", (code) => {
      if (code !== 0 && !settled) {
        settle(() => reject(new Error(`captcha worker exited (code ${code}) before solving`)));
      } else if (!settled) {
        settle(() => reject(new Error("captcha worker exited before responding")));
      }
    });
    worker.postMessage(msg);
  });
}

/** Worker-per-solve needs no concurrency plumbing -- kept for the pool API. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** Nothing long-lived to shut down: workers are terminated per solve. */
export function shutdownCaptchaSolver(): void {}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
}
