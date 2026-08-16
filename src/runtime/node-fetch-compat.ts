/**
 * Node-only global-fetch normalization for the Android (Node.js bundle) build.
 *
 * Node's global fetch (undici) enforces default client timeouts that Bun's
 * fetch does not: `headersTimeout` and `bodyTimeout` both default to 300000 ms
 * (undici `client.js`, verified 2026-08-16). A non-streaming LLM upstream sends
 * response headers only after the ENTIRE generation completes — deep-reasoning
 * requests legitimately exceed 300s. Those requests work on the Bun desktop
 * build but die as `UND_ERR_HEADERS_TIMEOUT` → 502 `upstream_unreachable` on
 * the Node Android build. This module restores the project's intended
 * "no upstream timeout on LLM calls" invariant (root AGENTS.md anti-pattern
 * #7) by swapping the global dispatcher for an Agent with both timeouts
 * disabled.
 *
 * The npm `undici` package shares the global-dispatcher registration symbol
 * with Node's built-in fetch, so `setGlobalDispatcher` from the package
 * configures the GLOBAL fetch (verified empirically: a 1 ms Agent aborts
 * global fetch with `UND_ERR_HEADERS_TIMEOUT`). esbuild bundles the dynamic
 * import into the Android `server.cjs`; on Bun this function is a no-op and
 * the import never executes.
 */

let applied = false;

/**
 * Disable Node fetch's default 300s headers/body timeouts. Safe to call from
 * any runtime and any number of times: no-op under Bun, runs once under Node.
 * Errors are reported but never thrown — a default-timeout process still
 * works for the common (<300s) request path.
 */
export async function ensureNodeFetchNoTimeouts(): Promise<void> {
  if (typeof Bun !== "undefined") return;
  if (applied) return;
  applied = true;
  try {
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
  } catch (err) {
    console.error(`zcode-proxy: could not disable Node fetch default timeouts: ${(err as Error).message}`);
  }
}
