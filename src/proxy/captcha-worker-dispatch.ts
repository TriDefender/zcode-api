/**
 * captcha-worker-dispatch.ts — solve execution: worker thread with an
 * in-process fallback.
 *
 * Each solve runs in its own worker_threads Worker so the proxy's main event
 * loop never blocks on the solver's Atomics.wait sync XHRs — in-process
 * solving froze every connection during refill bursts (issue #54, PR #55).
 * Worker-per-solve also isolates happy-dom's global browser-frame/cookie
 * state per solve, removing cross-solve races.
 *
 * Entry resolution, in priority order (see resolveWorkerEntryCandidates):
 *   1. ZCODE_CAPTCHA_WORKER env — absolute path, injected by the Android
 *      shell (NodeRunner extracts the APK asset next to server.cjs);
 *   2. captcha-worker-entry.cjs sibling of the running bundle (esbuild CJS
 *      keeps __dirname; Android assets land in the same directory);
 *   3. the build-time FILE ASSET (captcha-worker-asset.ts — `bun build
 *      --compile` cannot resolve `new Worker(new URL(...))` at runtime;
 *      exists only after scripts/build-fork-worker.ts runs; the esbuild
 *      Android bundle marks the asset module external).
 * When none resolves, deployments solve IN-PROCESS (the pre-worker behavior,
 * still bounded by CAPTCHA_SYNC_FETCH_TIMEOUT_MS / CAPTCHA_SOLVE_TIMEOUT_MS)
 * — EXCEPT under ZCODE_CAPTCHA_REQUIRE_WORKER=1 (Android strict mode):
 * worker unavailability is a hard solve failure, never a main-thread degrade.
 *
 * ZCODE_CAPTCHA_WARM_WORKERS>0 (Android: 3) switches dispatch from
 * worker-per-solve to a persistent warm pool: workers are reused across
 * solves (happy-dom window reuse is bounded inside captcha-happy —
 * CAPTCHA_REUSE_MAX_SOLVES / _IDLE_MS, issue #50 discipline), overflow falls
 * back to worker-per-solve, idle workers are reaped after
 * CAPTCHA_WARM_IDLE_MS, and a rapid-crash circuit breaker downgrades the
 * keeper to worker-per-solve so a broken entry cannot spawn-storm. Mode
 * transitions are announced once on stderr for operators.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

/** Per-solve timeout: overall deadline the worker gets before termination. */
const SOLVE_WORKER_TIMEOUT_MS = Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS || 30_000);

interface SolveRequest {
  id: number;
  scene: string;
  region: string;
  prefix: string;
}
type SolveResponse = { id: number; ok: true; param: string } | { id: number; ok: false; error: string };

let nextSolveId = 0;

// ---------------------------------------------------------------------------
// Entry resolution (pure candidates + filesystem probe) & strict mode
// ---------------------------------------------------------------------------

/** Sibling filename probed next to the running bundle (Android assets). */
const WORKER_ENTRY_SIBLING = "captcha-worker-entry.cjs";

/** ZCODE_CAPTCHA_REQUIRE_WORKER=1|true — never degrade to in-process solving. */
function strictWorkerRequired(): boolean {
  const v = process.env.ZCODE_CAPTCHA_REQUIRE_WORKER?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function bundleDir(): string | null {
  try {
    return typeof __dirname === "string" ? __dirname : null;
  } catch {
    return null;
  }
}

export interface WorkerEntryLookup {
  /** Explicit path (ZCODE_CAPTCHA_WORKER), injected by the Android shell. */
  envPath?: string;
  /** Directory of the running bundle; the entry ships as a sibling file. */
  bundleDir?: string | null;
}

/**
 * Filesystem candidates for the worker entry, in priority order. Pure so
 * tests can drive the ordering without touching process.env; the caller
 * probes each with existsSync (an explicitly configured-but-missing path is
 * an operator error worth announcing, an absent sibling is normal on
 * desktop dev runs and stays silent).
 */
export function resolveWorkerEntryCandidates(lookup: WorkerEntryLookup): string[] {
  const out: string[] = [];
  const env = lookup.envPath?.trim();
  if (env) out.push(env);
  if (lookup.bundleDir) out.push(join(lookup.bundleDir, WORKER_ENTRY_SIBLING));
  return out;
}

// Lazy-loaded in-process solver — imported only on the fallback path so
// processes that never solve (coding-plan) never pay the happy-dom startup.
type InProcessSolveFn = (opts: {
  scene: string;
  region: string;
  prefix: string;
}) => Promise<string>;
let inProcessOverride: InProcessSolveFn | null = null;
let happyMod: { solveTraceless: InProcessSolveFn } | null = null;
async function happy(): Promise<{ solveTraceless: InProcessSolveFn }> {
  if (inProcessOverride) return { solveTraceless: inProcessOverride };
  if (!happyMod) {
    happyMod = (await import("./captcha-happy.js")) as { solveTraceless: InProcessSolveFn };
  }
  return happyMod;
}

let entryPathCache: string | null | undefined;
let lastNotedMode = "";

/** Announce solve-mode TRANSITIONS only (worker <-> in-process), once each. */
function noteMode(mode: string, line: string): void {
  if (mode === lastNotedMode) return;
  lastNotedMode = mode;
  try { process.stderr.write(line); } catch {}
}

/**
 * Resolve the pre-bundled worker entry (build-time file asset). Cached
 * because a miss is permanent for the process lifetime: the bundle is a
 * build input that cannot appear while running. Never throws.
 */
async function getWorkerEntryPath(): Promise<string | null> {
  if (entryPathCache !== undefined) return entryPathCache;
  const envPath = process.env.ZCODE_CAPTCHA_WORKER?.trim() || undefined;
  for (const cand of resolveWorkerEntryCandidates({ envPath, bundleDir: bundleDir() })) {
    try {
      if (existsSync(cand)) {
        noteMode("worker", `[captcha-solver] worker-thread solving active (file: ${cand})\n`);
        entryPathCache = cand;
        return cand;
      }
    } catch {
      // Unprobeable path (illegal chars, permissions) — treat as absent.
    }
  }
  if (envPath) {
    // Explicitly configured but missing: operator error. Strict mode makes
    // every solve fail below; say so once instead of failing silently.
    noteMode(
      "worker-missing",
      `[captcha-solver] ZCODE_CAPTCHA_WORKER entry not found (${envPath})` +
        (strictWorkerRequired() ? " — strict mode: solves will FAIL instead of degrading to in-process\n" : "\n"),
    );
  }
  try {
    const m = await import("./captcha-worker-asset.js");
    const p = (m as { default?: unknown }).default;
    entryPathCache = typeof p === "string" && p ? p : null;
  } catch {
    entryPathCache = null;
  }
  if (entryPathCache) {
    noteMode("worker", "[captcha-solver] worker-thread solving active\n");
  } else {
    noteMode(
      "in-process",
      "[captcha-solver] worker entry unavailable — solving in-process " +
        "(run scripts/build-fork-worker.ts / bun run build to embed workers)\n",
    );
  }
  return entryPathCache;
}

/** Worker-entry unusable — the only worker failure that falls back. */
class WorkerUnavailableError extends Error {}

/** Load-stage failures (entry missing/unloadable); runtime crashes do NOT match. */
function isEntryUnavailableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    /cannot find module|module not found/i.test(String(e?.message ?? ""))
  );
}

export async function solveViaWorkerOrInProcess(req: {
  scene: string;
  region: string;
  prefix: string;
}): Promise<string> {
  const entryPath = await getWorkerEntryPath();
  if (entryPath === null) {
    if (strictWorkerRequired()) {
      const looked = resolveWorkerEntryCandidates({
        envPath: process.env.ZCODE_CAPTCHA_WORKER,
        bundleDir: bundleDir(),
      });
      throw new Error(
        `captcha worker entry unavailable (ZCODE_CAPTCHA_REQUIRE_WORKER=1 — no in-process fallback)` +
          (looked.length ? `; looked for: ${looked.join(", ")}` : ""),
      );
    }
    return (await happy()).solveTraceless(req);
  }
  if (warmWorkerTarget() > 0) {
    return warmSolve(entryPath, req);
  }
  return solveInWorkerDegrading(entryPath, req);
}

/**
 * Worker-per-solve with the legacy degrade ladder: a load-stage failure
 * (entry unloadable / spawn impossible) falls back to in-process solving —
 * EXCEPT in strict mode, where it is a hard failure.
 */
async function solveInWorkerDegrading(
  entryPath: string,
  req: { scene: string; region: string; prefix: string },
): Promise<string> {
  try {
    return await solveInWorker(entryPath, req);
  } catch (err) {
    if (err instanceof WorkerUnavailableError) {
      if (strictWorkerRequired()) {
        throw new Error(
          `captcha worker unavailable: ${err.message} (ZCODE_CAPTCHA_REQUIRE_WORKER=1 — no in-process fallback)`,
        );
      }
      return (await happy()).solveTraceless(req);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Warm worker pool (Android): persistent workers reused across solves
// ---------------------------------------------------------------------------

/** ZCODE_CAPTCHA_WARM_WORKERS — 0 (default) keeps worker-per-solve. */
function warmWorkerTarget(): number {
  const n = Number(process.env.ZCODE_CAPTCHA_WARM_WORKERS || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 16);
}

const WARM_IDLE_MS = Number(process.env.CAPTCHA_WARM_IDLE_MS || 600_000);
/** A worker that dies this fast after spawn counts toward the breaker. */
const WARM_RAPID_DEATH_MS = 5_000;
const WARM_MAX_RAPID_DEATHS = 3;
/** Cooldown before the keeper spawns again after any worker death. */
const WARM_SPAWN_BACKOFF_MS = 2_000;

interface PendingSolve {
  id: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (param: string) => void;
  reject: (err: Error) => void;
}

interface WarmHandle {
  worker: Worker;
  busy: boolean;
  broken: boolean;
  spawnedAt: number;
  lastUsedAt: number;
  pending: PendingSolve | null;
}

let warmWorkers: WarmHandle[] = [];
let warmRapidDeaths = 0;
let warmDisabled = false;
let warmSpawnBlockedUntil = 0;
let warmSweeper: ReturnType<typeof setInterval> | null = null;

function dropFromPool(h: WarmHandle): void {
  warmWorkers = warmWorkers.filter((w) => w !== h);
}

/** Terminate a warm worker: reject its in-flight solve (if any), detach
 *  listeners FIRST so the post-terminate "exit" event cannot re-account. */
function killWarm(h: WarmHandle, cause: string): void {
  if (h.broken) return;
  h.broken = true;
  const p = h.pending;
  h.pending = null;
  if (p) {
    clearTimeout(p.timer);
    p.reject(new Error(cause));
  }
  try { h.worker.removeAllListeners(); } catch {}
  try { h.worker.terminate(); } catch {}
}

function noteWarmDeath(h: WarmHandle): void {
  if (Date.now() - h.spawnedAt < WARM_RAPID_DEATH_MS) {
    warmRapidDeaths += 1;
    if (warmRapidDeaths >= WARM_MAX_RAPID_DEATHS && !warmDisabled) {
      warmDisabled = true;
      noteMode(
        "warm-disabled",
        `[captcha-solver] warm worker pool disabled after ${warmRapidDeaths} rapid crashes — using worker-per-solve instead\n`,
      );
    }
  } else {
    // It did useful work before dying — not a spawn-loop signature.
    warmRapidDeaths = 0;
  }
  warmSpawnBlockedUntil = Date.now() + WARM_SPAWN_BACKOFF_MS;
}

function ensureWarmSweeper(): void {
  if (warmSweeper) return;
  warmSweeper = setInterval(() => {
    const now = Date.now();
    warmWorkers = warmWorkers.filter((h) => {
      if (!h.busy && now - h.lastUsedAt > WARM_IDLE_MS) {
        killWarm(h, "captcha warm worker idle-reaped");
        return false;
      }
      return true;
    });
    if (warmWorkers.length === 0 && warmSweeper) {
      clearInterval(warmSweeper);
      warmSweeper = null;
    }
  }, 30_000);
  warmSweeper.unref?.();
}

function spawnWarm(entryPath: string): { handle?: WarmHandle; spawnError?: Error } {
  const h: WarmHandle = {
    worker: null as unknown as Worker,
    busy: false,
    broken: false,
    spawnedAt: Date.now(),
    lastUsedAt: Date.now(),
    pending: null,
  };
  try {
    h.worker = new Worker(entryPath);
  } catch (err) {
    return { spawnError: err instanceof Error ? err : new Error(String(err)) };
  }
  warmWorkers.push(h);
  h.worker.on("message", (m: SolveResponse) => {
    const p = h.pending;
    if (!p || !m || m.id !== p.id) return;
    h.pending = null;
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.param);
    else p.reject(new Error(m.error));
  });
  h.worker.on("error", (err: Error) => {
    killWarm(h, `captcha warm worker error: ${err.message}`);
    dropFromPool(h);
    noteWarmDeath(h);
  });
  h.worker.on("exit", (code: number) => {
    if (h.broken) return; // killWarm already handled this death
    killWarm(h, `captcha warm worker exited (code ${code})`);
    dropFromPool(h);
    noteWarmDeath(h);
  });
  ensureWarmSweeper();
  noteMode("warm", `[captcha-solver] warm worker pool active (target ${warmWorkerTarget()})\n`);
  return { handle: h };
}

function acquireWarm(entryPath: string): { handle?: WarmHandle; spawnError?: Error } {
  const idle = warmWorkers.find((h) => !h.busy && !h.broken);
  if (idle) return { handle: idle };
  if (warmDisabled || warmWorkers.length >= warmWorkerTarget()) return {};
  if (Date.now() < warmSpawnBlockedUntil) return {};
  return spawnWarm(entryPath);
}

function dispatchToWarm(h: WarmHandle, req: { scene: string; region: string; prefix: string }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const id = ++nextSolveId;
    const timer = setTimeout(() => {
      killWarm(h, `captcha worker timeout (${SOLVE_WORKER_TIMEOUT_MS}ms)`);
      dropFromPool(h);
      noteWarmDeath(h);
    }, SOLVE_WORKER_TIMEOUT_MS);
    h.busy = true;
    h.pending = { id, timer, resolve, reject };
    h.worker.postMessage({ id, scene: req.scene, region: req.region, prefix: req.prefix });
  });
}

async function warmSolve(entryPath: string, req: { scene: string; region: string; prefix: string }): Promise<string> {
  const acq = acquireWarm(entryPath);
  if (acq.spawnError) {
    if (strictWorkerRequired()) {
      throw new Error(
        `captcha warm worker spawn failed: ${acq.spawnError.message} (ZCODE_CAPTCHA_REQUIRE_WORKER=1 — no in-process fallback)`,
      );
    }
    // Spawning is broken in this deployment — stop trying, degrade to the
    // per-solve ladder (which itself degrades to in-process when unstrict).
    warmDisabled = true;
    noteMode(
      "warm-disabled",
      `[captcha-solver] warm worker spawn failed (${acq.spawnError.message}) — using worker-per-solve instead\n`,
    );
    return solveInWorkerDegrading(entryPath, req);
  }
  if (!acq.handle) {
    // Pool busy / breaker tripped / backing off — spawn a one-shot worker
    // (still off the main thread), never in-process.
    return solveInWorkerDegrading(entryPath, req);
  }
  const h = acq.handle;
  try {
    const param = await dispatchToWarm(h, req);
    h.busy = false;
    h.lastUsedAt = Date.now();
    return param;
  } catch (err) {
    // ok:false replies (solver-level failures: F008, verify errors, pe
    // stalls) leave the worker healthy — return it to the idle pool. Broken
    // workers were already killed, dropped and accounted by their handler.
    if (!h.broken) {
      h.busy = false;
      h.lastUsedAt = Date.now();
    }
    throw err;
  }
}

/**
 * Terminate all persistent warm workers and reset the keeper. Called by
 * shutdownCaptchaSolver (stopCaptchaPool chain — e.g. the Android `stopProxy`
 * control command) so a stopped proxy holds no worker memory.
 */
export function stopCaptchaWorkers(): void {
  for (const h of warmWorkers) killWarm(h, "captcha warm workers stopped");
  warmWorkers = [];
  warmRapidDeaths = 0;
  warmDisabled = false;
  warmSpawnBlockedUntil = 0;
  if (warmSweeper) {
    clearInterval(warmSweeper);
    warmSweeper = null;
  }
}

/**
 * One solve = one Worker. Startup cost is a few ms (happy-dom loads lazily
 * inside the entry on first message); termination guarantees no state leaks
 * between solves. A hung solve cannot wedge anything: the worker timeout
 * (30s) fires first and force-terminates here; the pool's takeToken race
 * deadline (35s) is the outer backstop.
 */
function solveInWorker(
  entryPath: string,
  req: { scene: string; region: string; prefix: string },
): Promise<string> {
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
      worker = new Worker(entryPath);
    } catch (err) {
      const msg = `captcha worker spawn failed: ${(err as Error).message}`;
      noteMode("in-process", `[captcha-solver] ${msg} — degrading to in-process solving\n`);
      settle(() => reject(new WorkerUnavailableError(msg)));
      return;
    }
    const msg: SolveRequest = { id, ...req };
    worker.on("message", (m: SolveResponse) => {
      if (!m || m.id !== id) return;
      if (m.ok) settle(() => resolve(m.param));
      else settle(() => reject(new Error(m.error)));
    });
    worker.on("error", (err: Error) => {
      // A load-stage failure (entry unloadable) means workers are unusable in
      // this deployment — degrade. Anything else (crash/OOM inside a loaded
      // worker) stays a hard failure: retrying it on the MAIN thread is the
      // #54/#50 failure shape, and the pool's retry ladder rolls a fresh
      // worker instead.
      if (isEntryUnavailableError(err)) {
        noteMode(
          "in-process",
          `[captcha-solver] captcha worker entry failed to load: ${err.message} — degrading to in-process solving\n`,
        );
        settle(() => reject(new WorkerUnavailableError(`captcha worker entry failed to load: ${err.message}`)));
      } else {
        settle(() => reject(new Error(`captcha worker error: ${err.message}`)));
      }
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

/** Test-only: clear the entry/happy caches so dispatch order can be re-run. */
export function __resetCaptchaWorkerDispatchForTest(): void {
  entryPathCache = undefined;
  happyMod = null;
  lastNotedMode = "";
  stopCaptchaWorkers();
}

/**
 * Test-only: substitute the in-process solver. Tests must use this seam
 * instead of mock.module("./captcha-happy.js", …) — a module mock is
 * process-wide in Bun and leaks a PARTIAL export surface into whichever
 * test file loads captcha-happy afterwards (breaking e.g. __captchaMemStats
 * importers, order-dependently across platforms).
 */
export function __setInProcessSolverForTest(fn: InProcessSolveFn | null): void {
  inProcessOverride = fn;
}
