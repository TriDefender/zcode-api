/**
 * Upstream traffic dumper — used for debugging "JSON request body" issues.
 *
 * Activated by env `ZCODE_DUMP_UPSTREAM=<path>`: every proxied request emits
 * one JSONL line per phase (`client_in` / `upstream_out` / `upstream_in` /
 * `upstream_body_sample`), so the full request→response timeline can be
 * inspected offline. Inactive (no-op) when the env var is unset.
 *
 * Design constraints:
 * - Must NEVER affect request handling — all FS work is try/catch'd.
 * - Sensitive header values (Authorization / x-api-key / captcha tokens /
 *   proxy secrets) are masked to `abcd1234…wxyz` so fingerprints are visible
 *   while credentials stay redacted.
 * - Bodies are JSON.parsed and re-stringified when possible (for readability);
 *   otherwise emitted as the raw string.
 *
 * The dump file is line-oriented JSON (JSONL); each line is self-contained:
 *
 *   {"ts":"2026-07-31T12:00:00.000Z","reqId":"#001","phase":"client_in", ...}
 *
 * Pair lines by `reqId` to reconstruct a full request timeline.
 */
import { appendFileSync } from "node:fs";

const DUMP_PATH = process.env.ZCODE_DUMP_UPSTREAM;

/** Header names whose values must be masked before dumping. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "proxy-api-key",
  "x-zcode-captcha-verify-param",
  "x-zcode-captcha-verify-region",
  "cookie",
]);

function maskHeaderValue(key: string, value: string): string {
  if (!SENSITIVE_HEADERS.has(key.toLowerCase())) return value;
  if (value.length <= 12) return "<redacted>";
  return `${value.slice(0, 8)}…${value.slice(-4)} (len=${value.length})`;
}

/** Convert a Headers object to a plain object with sensitive values masked. */
export function dumpHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    out[k] = maskHeaderValue(k, v);
  }
  return out;
}

/** Try to parse body as JSON for pretty emission; fall back to raw string. */
export function dumpBody(body: string | undefined | null): unknown {
  if (body === undefined || body === null) return undefined;
  if (body.length === 0) return "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

interface DumpLine {
  ts: string;
  reqId: string;
  phase: string;
  [k: string]: unknown;
}

/**
 * Append one dump line. No-op when `ZCODE_DUMP_UPSTREAM` is unset.
 * All errors are swallowed — dumping must never break request handling.
 */
export function dumpPhase(reqId: string, phase: string, data: Record<string, unknown>): void {
  if (!DUMP_PATH) return;
  try {
    const line: DumpLine = {
      ts: new Date().toISOString(),
      reqId,
      phase,
      ...data,
    };
    appendFileSync(DUMP_PATH, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    // intentional swallow — see header comment
  }
}

/** True when dumping is active. Cheap check used to gate per-phase logic in handler. */
export function dumpEnabled(): boolean {
  return !!DUMP_PATH;
}
