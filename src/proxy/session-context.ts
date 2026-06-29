/**
 * Session context resolution and header-emission policy.
 *
 * Both coding-plan and start-plan call the same resolver. The config decides
 * whether inferred lineage is only observed or is forwarded upstream.
 */
import type { ProxyConfig } from "../config/types.js";
import type { Format } from "../translator/types.js";
import {
  defaultClientSessionResolver,
  type ClientSessionAction,
  type ClientSessionResolver,
  type ClientSessionResult,
  type ClientSessionSource,
} from "./client-session.js";

export interface ResolveSessionContextInput {
  clientReq: Request;
  body: string | undefined;
  upstreamFormat: Format;
  model: string;
  config: ProxyConfig;
  resolver?: ClientSessionResolver;
}

export interface SessionHeaderContext {
  source?: ClientSessionSource;
  action: ClientSessionAction;
  sessionId?: string;
  upstreamSessionId?: string;
  requestId?: string;
  traceId?: string;
  queryId?: string;
}

export function resolveSessionContext(input: ResolveSessionContextInput): ClientSessionResult | undefined {
  if (input.config.clientIdentity.mode === "off") return undefined;
  const resolver = input.resolver ?? defaultClientSessionResolver;
  return resolver.resolve(input.clientReq, input.body, input.upstreamFormat, input.model, input.config.clientIdentity);
}

export function shouldUseExactTraceHeaders(
  plan: "coding-plan" | "start-plan",
  session?: SessionHeaderContext,
): boolean {
  return plan === "start-plan" || hasExplicitTraceHeaders(session) || shouldForwardSessionId(session);
}

export function shouldForwardSessionId(session?: SessionHeaderContext): boolean {
  return session?.source === "explicit" || session?.action === "enforce";
}

export function sessionIdForHeader(session?: SessionHeaderContext): string | undefined {
  if (!session || !shouldForwardSessionId(session)) return undefined;
  return session.upstreamSessionId ?? session.sessionId;
}

function hasExplicitTraceHeaders(session?: SessionHeaderContext): boolean {
  return Boolean(session?.requestId || session?.traceId || session?.queryId);
}
