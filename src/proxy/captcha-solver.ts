/**
 * Solver backend dispatch — fully in-process, self-contained.
 *
 * Backend (ZCODE_CAPTCHA_BACKEND): "happy" (default) — the happy-dom solver
 * in src/proxy/captcha-happy.ts. Runs inside the Bun process; bundled into
 * the single-file release binary by `bun build --compile`. No external
 * Node.js, no browser. (The historical jsdom and Node-daemon/playwright
 * backends have been removed.)
 */
const BACKEND = process.env.ZCODE_CAPTCHA_BACKEND?.trim().toLowerCase() || "happy";

let happyMod: typeof import("./captcha-happy.js") | null = null;

export async function runCaptchaSolve(scene: string, region: string, prefix: string): Promise<string> {
  if (BACKEND !== "happy") {
    throw new Error(`captcha backend "${BACKEND}" is not available; use ZCODE_CAPTCHA_BACKEND=happy`);
  }
  if (!happyMod) happyMod = await import("./captcha-happy.js");
  return happyMod.solveTraceless({ scene, region, prefix });
}

/** In-process solving needs no worker pool management — kept for the pool API. */
export function setCaptchaSolverConcurrency(_n: number): void {}

/** In-process solving needs no worker pool management — kept for the pool API. */
export function shutdownCaptchaSolver(): void {}

export function captchaSolverConcurrency(): number {
  return Number(process.env.CAPTCHA_DAEMON_CONCURRENCY || 4);
}
