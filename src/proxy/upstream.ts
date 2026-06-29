/**
 * Upstream request builder — constructs the forwarded HTTP request.
 *
 * **`format` semantics**: This is the *upstream* format — the format used to
 * talk to the upstream LLM provider, not the client's inbound format. Coding-plan
 * OpenAI clients are translated to Anthropic upstream; start-plan always uses
 * ZCode's OpenAI-compatible gateway.
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
import { buildZcodeTraceHeaders } from "./trace-headers.js";
import { sessionIdForHeader, shouldUseExactTraceHeaders } from "./session-context.js";

export interface UpstreamClientSession {
  source?: "none" | "explicit" | "lineage";
  action: "off" | "observe" | "enforce";
  sessionId?: string;
  upstreamSessionId?: string;
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

export type UpstreamHeaderPair = [string, string];

const ANTHROPIC_VERSION = "2023-06-01";

const STARTPLAN_OPENAI_BASE = "https://zcode.z.ai/api/v1/zcode-plan";

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
    return `${STARTPLAN_OPENAI_BASE}/chat/completions`;
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
 * - OpenAI upstream, coding-plan    → `Authorization: Bearer {cred}`
 * - OpenAI upstream, start-plan     → `Authorization: Bearer {jwt}`
 *
 * Trace/attribution headers mirror the bundle's `Bdt`
 * ("createModelRequestAttributionHeaders") when an explicit/enforced trace
 * context exists. Default observe mode keeps the prior synthesized query/session
 * behavior for compatibility.
 */
export function buildAuthHeaders(
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  clientSession?: UpstreamClientSession,
): Record<string, string> {
  const credStr = plan === "start-plan" && cred.jwt ? cred.jwt : credentialString(cred);
  const base: Record<string, string> = {
    ...buildIdentityHeaders(identity),
    ...buildTraceHeaders(plan, clientSession),
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

function buildTraceHeaders(plan: "coding-plan" | "start-plan", clientSession?: UpstreamClientSession): Record<string, string> {
  if (shouldUseExactTraceHeaders(plan, clientSession)) {
    return buildZcodeTraceHeaders({
      requestId: clientSession?.requestId,
      traceId: clientSession?.traceId,
      queryId: clientSession?.queryId,
      sessionId: sessionIdForHeader(clientSession),
    });
  }

  const headers: Record<string, string> = {
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
  };
  if (plan !== "start-plan") {
    headers["x-query-id"] = crypto.randomUUID();
    headers["x-session-id"] = crypto.randomUUID();
  }
  return headers;
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

export function buildUpstreamHeaderPairs(
  clientReq: Request,
  format: Format,
  cred: Credential,
  identity: ProxyIdentity,
  plan: "coding-plan" | "start-plan" = "coding-plan",
  extraHeaders?: Record<string, string>,
  clientSession?: UpstreamClientSession,
): UpstreamHeaderPair[] {
  return [
    ["content-type", "application/json"],
    ["accept-encoding", "gzip"],
    ...Object.entries(collectPassthroughHeaders(clientReq)),
    ...Object.entries(buildAuthHeaders(format, cred, identity, plan, clientSession)),
    ...Object.entries(extraHeaders ?? {}),
  ];
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
  clientSession?: UpstreamClientSession,
): Request {
  const url = buildUpstreamURL(format, provider, plan);
  const headerPairs = buildUpstreamHeaderPairs(clientReq, format, cred, identity, plan, extraHeaders, clientSession);

  const init: RequestInit = {
    method: "POST",
    headers: Object.fromEntries(headerPairs),
  };

  if (body !== undefined) {
    init.body = body;
  }

  return new Request(url, init);
}
