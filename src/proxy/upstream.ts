/**
 * Upstream request builder — constructs the forwarded HTTP request.
 *
 * **`format` semantics**: This is the *upstream* format — the format used to
 * talk to the upstream LLM provider, not the client's inbound format. When
 * `handler.ts` translates an OpenAI client request to Anthropic upstream in
 * coding-plan mode, it passes `"anthropic"` here even though the client
 * originally spoke OpenAI. The route's format is tracked separately in
 * `handler.ts` for response translation decisions.
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import type { ProxyIdentity } from "../config/types.js";
import { credentialString } from "../auth/types.js";
import { buildIdentityHeaders } from "./identity.js";

const ANTHROPIC_VERSION = "2023-06-01";

const STARTPLAN_ANTHROPIC_BASE = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

const STRIP_HEADERS = new Set([
  "host",
  "authorization",
  "x-api-key",
  "anthropic-version",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
  "x-request-id",
  "x-zcode-trace-id",
  "x-query-id",
  "x-session-id",
]);

/**
 * Build the upstream URL based on format + plan + provider.
 *
 * The `format` parameter is the *upstream* format — callers in handler.ts
 * pass the format the upstream will receive, which may differ from the
 * client's inbound format when the proxy is in translation mode.
 */
export function buildUpstreamURL(format: Format, provider: ProviderDef, plan: "coding-plan" | "start-plan" = "coding-plan"): string {
  if (plan === "start-plan") {
    return `${STARTPLAN_ANTHROPIC_BASE}/v1/messages`;
  }
  if (format === "anthropic") {
    return `${provider.anthropicBaseURL}/v1/messages`;
  }
  return `${provider.openaiBaseURL}/chat/completions`;
}

/**
 * Build auth + identity + trace headers for the upstream request.
 *
 * The `format` parameter is the *upstream* format — selects auth scheme:
 * - Anthropic upstream, coding-plan → `x-api-key: {cred}` + `anthropic-version`
 * - Anthropic upstream, start-plan  → `Authorization: Bearer {jwt}` + `anthropic-version`
 * - OpenAI upstream (coding-plan)   → `Authorization: Bearer {cred}`
 *
 * Trace/attribution headers mirror the bundle's `wdt`
 * ("createModelRequestAttributionHeaders"). That helper emits `x-request-id`
 * and `x-zcode-trace-id` unconditionally, and `x-query-id` / `x-session-id`
 * only when those IDs exist — with their internal prefixes stripped
 * (`query_`, `sess_`, `subagent_agent_`), so the wire values are bare UUIDs.
 * The proxy has no session lifecycle, so it always synthesizes fresh bare UUIDs
 * for all four (matching what a live ZCode turn sends on the wire).
 *
 * See module header for translation semantics.
 */
export function buildAuthHeaders(format: Format, cred: Credential, identity: ProxyIdentity, plan: "coding-plan" | "start-plan" = "coding-plan"): Record<string, string> {
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const base: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
    // `wdt` strips the `query_` / `sess_` internal prefixes — wire values are bare UUIDs.
    "x-query-id": crypto.randomUUID(),
    "x-session-id": crypto.randomUUID(),
  };

  if (format === "anthropic") {
    if (plan === "start-plan" && cred.jwt) {
      base["authorization"] = `Bearer ${cred.jwt}`;
    } else {
      base["x-api-key"] = credStr;
    }
    base["anthropic-version"] = ANTHROPIC_VERSION;
  } else {
    base["authorization"] = `Bearer ${credStr}`;
  }

  return base;
}

function collectPassthroughHeaders(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (STRIP_HEADERS.has(lower)) continue;
    if (lower === "anthropic-beta") {
      result[lower] = value;
    }
  }
  return result;
}

export function buildUpstreamRequest(
  clientReq: Request,
  format: Format,
  provider: ProviderDef,
  cred: Credential,
  body: string | undefined,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
): Request {
  const url = buildUpstreamURL(format, provider, plan);
  const authHeaders = buildAuthHeaders(format, cred, identity, plan);
  const passthrough = collectPassthroughHeaders(clientReq);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "gzip",
    ...passthrough,
    ...authHeaders,
    ...extraHeaders,
  };

  const init: RequestInit = {
    method: "POST",
    headers,
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
