export interface ZcodeTraceContext {
  requestId?: string;
  traceId?: string;
  queryId?: string;
  sessionId?: string;
  /** Optional override; one of "main" | "subagent" | "other" (ZCode 3.9.1 session types). */
  sessionType?: string;
}

const QUERY_PREFIX = "query_";
const SUBAGENT_PREFIX = "subagent_agent_";
const SESSION_PREFIXES = ["sess_", SUBAGENT_PREFIX];

/**
 * Resolve the `x-zcode-session-type` attribution value, mirroring the ZCode
 * 3.9.1 bundle's `resolveModelRequestSessionType`/`isModelRequestSessionType`.
 *
 * The bundle derives main/subagent/other from the agent orchestration context.
 * The proxy's equivalent signal is the client session id: ZCode-style harnesses
 * prefix subagent sessions with `subagent_agent_`. Every other forwarded
 * conversation turn is the moral equivalent of the main agent loop ("main");
 * an explicit ctx.sessionType wins when provided and valid.
 */
function resolveSessionType(ctx: ZcodeTraceContext): "main" | "subagent" | "other" {
  const explicit = ctx.sessionType?.trim();
  if (explicit === "main" || explicit === "subagent" || explicit === "other") return explicit;
  if (ctx.sessionId?.startsWith(SUBAGENT_PREFIX) && ctx.sessionId.length > SUBAGENT_PREFIX.length) return "subagent";
  return "main";
}

/**
 * Mirrors ZCode's attribution header helper (`createModelRequestAttributionHeaders`).
 *
 * ZCode 3.9.1 emits, in this order: x-request-id, x-zcode-session-type,
 * x-zcode-trace-id, [x-query-id], [x-session-id]. The session-type header is
 * unconditional (always resolves to main/subagent/other).
 */
export function buildZcodeTraceHeaders(ctx: ZcodeTraceContext = {}): Record<string, string> {
  const queryId = ctx.queryId ? stripHeaderInternalPrefixes(ctx.queryId, [QUERY_PREFIX]) : undefined;
  const sessionId = ctx.sessionId ? stripHeaderInternalPrefixes(ctx.sessionId, SESSION_PREFIXES) : undefined;
  return {
    "x-request-id": ctx.requestId ?? crypto.randomUUID(),
    "x-zcode-session-type": resolveSessionType(ctx),
    "x-zcode-trace-id": ctx.traceId ?? crypto.randomUUID(),
    ...(queryId ? { "x-query-id": queryId } : {}),
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
}

export function stripHeaderInternalPrefixes(value: string, prefixes: string[]): string {
  let out = value;
  for (const prefix of prefixes) {
    if (out.startsWith(prefix) && out.length > prefix.length) out = out.slice(prefix.length);
  }
  return out || value;
}
