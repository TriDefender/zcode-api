/**
 * Captcha solver worker entry -- fork patch.
 *
 * Runs the happy-dom solver (captcha-happy.ts) inside a worker thread so the
 * proxy's main event loop NEVER blocks on Atomics.wait sync XHRs. One solve
 * per worker at a time: the module's global browser-frame/cookie state is
 * per-worker, which also removes the cross-solve global races of in-process
 * parallel solving.
 *
 * Protocol: {id, scene, region, prefix} in -> {id, ok, param|error} out.
 * Spawned by captcha-solver.ts via a build-time FILE ASSET import
 * (`with { type: "file" }`) -- the only worker mechanism that survives
 * `bun build --compile` single-file binaries (verified on Bun 1.4).
 */
import { parentPort } from "node:worker_threads";
import { solveTraceless } from "./captcha-happy.js";

type SolveMsg = { id: number; scene: string; region: string; prefix: string };

const port = parentPort;
if (!port) throw new Error("captcha worker entry requires a worker_threads parent");

port.on("message", (m: SolveMsg) => {
  void (async () => {
    try {
      const param = await solveTraceless({ scene: m.scene, region: m.region, prefix: m.prefix });
      port.postMessage({ id: m.id, ok: true, param });
    } catch (err) {
      port.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err) });
    }
  })();
});
