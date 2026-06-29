export interface ZcodeTraceContext {
  requestId?: string;
  traceId?: string;
  queryId?: string;
  sessionId?: string;
}

const QUERY_PREFIX = "query_";
const SESSION_PREFIXES = ["sess_", "subagent_agent_"];

/** Mirrors ZCode's Bdt/Ioo/Coo/vCr attribution header helper. */
export function buildZcodeTraceHeaders(ctx: ZcodeTraceContext = {}): Record<string, string> {
  const queryId = ctx.queryId ? stripHeaderInternalPrefixes(ctx.queryId, [QUERY_PREFIX]) : undefined;
  const sessionId = ctx.sessionId ? stripHeaderInternalPrefixes(ctx.sessionId, SESSION_PREFIXES) : undefined;
  return {
    "x-request-id": ctx.requestId ?? crypto.randomUUID(),
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
