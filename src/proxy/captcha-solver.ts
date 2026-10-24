/**
 * Solver backend dispatch.
 *
 * Backend (ZCODE_CAPTCHA_BACKEND): "happy" (default) — the happy-dom solver
 * in src/proxy/captcha-happy.ts. Execution (one worker thread per solve, a
 * persistent warm pool on Android / in-process fallback where no entry is
 * available — issue #54) lives in captcha-worker-dispatch.ts.
 */
import { solveViaWorkerOrInProcess, stopCaptchaWorkers } from "./captcha-worker-dispatch.js";

const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    throw new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`);
  }
  return solveViaWorkerOrInProcess({ scene, region, prefix });
}

/** Worker-per-solve needs no concurrency plumbing — kept for the pool API. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** Worker-per-solve terminates itself; the persistent warm pool
 *  (ZCODE_CAPTCHA_WARM_WORKERS, Android) is terminated here — called by the
 *  stopCaptchaPool / shutdownCaptcha chain. */
export function shutdownCaptchaSolver(): void {
  stopCaptchaWorkers();
}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
}
