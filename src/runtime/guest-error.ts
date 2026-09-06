/**
 * guest-error.ts — provenance test for errors thrown by third-party captcha
 * SDK code ("guest" scripts) running inside the in-process happy-dom solver.
 *
 * Under Bun the guest scripts execute in the HOST realm (happy-dom's VM
 * isolation is a no-op there), so an error escaping a guest callback reaches
 * process-level `uncaughtException` exactly like an error from our own code.
 * The two must not share a fate: a rotated pe/FeiLin bundle tripping over an
 * emulation gap must fail that one solve — the pool retries — while a genuine
 * fault in the proxy still terminates loudly.
 *
 * `serve` mode already draws that line (captcha-happy.ts logs and continues).
 * The TUI's own uncaughtException handler used to exit(1) for everything,
 * which turned a recoverable guest error into a dead proxy:
 *
 *     zcode-proxy: tui crashed: ReferenceError: moveBy is not defined
 *         at tE (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin008…js)
 *
 * Evidence is the source URL of the throwing frame: guest bundles are served
 * from Aliyun CDN/API hosts and carry those URLs in their stack frames (and,
 * for generated code, in the `//# sourceURL` we preserve when evaluating).
 */

// CDN/API hosts serving the Aliyun captcha SDK bundles. Anchored at the URL
// authority (`scheme://`, optional userinfo) and terminated by a port/path/
// delimiter, so the domain must be the real host — `evil-alicdn.com.bad.net`
// and `…?ref=alicdn.com` are not guest evidence.
const GUEST_SCRIPT_HOST =
  /https?:\/\/(?:[^/\s@]*@)?(?:[a-z0-9-]+\.)*(?:alicdn\.com|aliyuncs\.com)(?=[:/?#]|\s|$)/i;

/** Follows `cause` chains without looping on self-referential errors. */
function* errorChain(err: unknown, depth = 4): Generator<object> {
  const seen = new Set<unknown>();
  let current = err;
  for (let i = 0; i < depth; i++) {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    yield current as object;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * True when `err` originates in third-party captcha SDK code.
 *
 * Deliberately conservative: only a guest source URL counts as evidence. A
 * missing/truncated stack yields `false`, so an unattributable error keeps the
 * strict (fatal) treatment.
 */
export function isGuestOriginError(err: unknown): boolean {
  for (const link of errorChain(err)) {
    const e = link as { stack?: unknown; sourceURL?: unknown; message?: unknown };
    if (typeof e.stack === "string" && GUEST_SCRIPT_HOST.test(e.stack)) return true;
    // Bun/JSC attach the throwing script's URL directly on the error.
    if (typeof e.sourceURL === "string" && GUEST_SCRIPT_HOST.test(e.sourceURL)) return true;
    if (typeof e.message === "string" && GUEST_SCRIPT_HOST.test(e.message)) return true;
  }
  return false;
}

/** One-line render of a guest error for the log pane / stderr. */
export function describeGuestError(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "Error";
  const message = typeof e?.message === "string" ? e.message : String(err);
  const frame =
    typeof e?.stack === "string"
      ? (e.stack.split("\n").find((line) => GUEST_SCRIPT_HOST.test(line)) ?? "").trim()
      : "";
  // Bundle URLs carry a 64-char content hash — keep the readable filename only.
  const source = frame.replace(/^at\s+/, "").replace(/https?:\/\/[^\s)]*\/([^/\s)]+)/, "$1");
  return source ? `${name}: ${message} (${source})` : `${name}: ${message}`;
}
