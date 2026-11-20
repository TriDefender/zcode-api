/**
 * Aggregated MCP route: ONE `/mcp` endpoint exposing every official plugin's
 * tools (namespaced `{plugin}__{tool}`). Replaces the old per-plugin
 * `/mcp/{key}` passthrough relay — clients configure a single MCP server URL.
 *
 * Surface (streamable HTTP; the aggregate itself is stateless — no client
 * session id is issued, upstream sessions are internal, see aggregate.ts):
 *   POST   /mcp  JSON-RPC: initialize / ping / tools/list / tools/call,
 *                notifications (→202), JSON-RPC batches
 *   GET    /mcp  human listing (JSON / HTML for browsers); MCP clients that
 *                ask for an SSE stream get 405 — this server never pushes
 *   DELETE /mcp  close all cached upstream plugin sessions
 *
 * Inbound auth is the shared proxyApiKey gate in `server.ts::createFetchHandler`
 * (same semantics as the LLM routes); outbound auth is the stored OAuth
 * credential via `src/mcp/upstream.ts` (coding-plan only — the gateway rejects
 * identity-only credentials with JSON-RPC 3101, so start-plan gets an explicit
 * 400 here, mirroring the async-route pattern).
 *
 * The aggregate instance (upstream sessions + tools cache) is cached per
 * credential fingerprint so repeated calls reuse sessions; DELETE drops it and
 * a re-login (different fingerprint) rebuilds it automatically.
 *
 * Route registration lives in `server.ts` (gated by `config.mcp.gateway.enabled`).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"
 */
import { createHash } from "node:crypto";
import {
  buildOfficialMcpAuthHeaders,
  McpCredentialsUnavailableError,
  type OfficialMcpAuth,
  type McpCredentialReason,
} from "../mcp/upstream.js";
import { McpAggregateServer, type JsonRpcMessage, type JsonRpcReply } from "../mcp/aggregate.js";
import { OFFICIAL_MCP_CATALOGUE } from "../mcp/catalogue.js";
import { errorResponse } from "../proxy/handler.js";
import type { Credential } from "../auth/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";

export interface McpRouteOptions {
  config: ProxyConfig;
  auth: AuthManager;
  fetchImpl?: typeof fetch;
}

type McpAuthStatus =
  | { ok: true; auth: OfficialMcpAuth; fingerprint: string }
  | { ok: false; reason: McpCredentialReason | "not_logged_in" | "plan_unsupported"; message: string };

function resolveMcpAuth(cred: Credential | null, plan: ProxyConfig["plan"]): McpAuthStatus {
  if (plan !== "coding-plan") {
    return {
      ok: false,
      reason: "plan_unsupported",
      message: `the /mcp endpoint requires plan "coding-plan" (current plan: ${plan})`,
    };
  }
  if (!cred) {
    return {
      ok: false,
      reason: "not_logged_in",
      message: "not logged in — run: zcode-proxy auth login <zai|zai_cn>",
    };
  }
  try {
    const auth = buildOfficialMcpAuthHeaders(cred);
    const fingerprint = credentialFingerprint(cred);
    return { ok: true, auth, fingerprint };
  } catch (err) {
    if (err instanceof McpCredentialsUnavailableError) {
      return { ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

function credentialFingerprint(cred: Credential): string {
  return createHash("sha256").update(`${cred.jwt ?? ""}|${cred.apiKey ?? ""}|${cred.secret ?? ""}`).digest("hex").slice(0, 16);
}

/** Aggregate instances cached per credential fingerprint (sessions + tools). */
let cachedAggregate: { fingerprint: string; server: McpAggregateServer } | null = null;

/** Test seam: drop the cached aggregate (fingerprint-keyed) — tests only. */
export function resetMcpAggregateCache(): void {
  cachedAggregate = null;
}

function aggregateFor(opts: McpRouteOptions, auth: OfficialMcpAuth, fingerprint: string): McpAggregateServer {
  if (cachedAggregate?.fingerprint === fingerprint) return cachedAggregate.server;
  const server = new McpAggregateServer(opts.config.mcp.gateway.upstreamOrigin, auth, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  cachedAggregate = { fingerprint, server };
  return server;
}

/** Any of POST/GET/DELETE /mcp. */
export async function handleMcpRoute(req: Request, opts: McpRouteOptions): Promise<Response> {
  if (req.method === "GET") return handleMcpListing(req, opts);
  if (req.method === "DELETE") return handleMcpClose(opts);
  return handleMcpRpc(req, opts);
}

/** POST /mcp — one JSON-RPC message or a batch. */
async function handleMcpRpc(req: Request, opts: McpRouteOptions): Promise<Response> {
  const status = await resolveAuthForRpc(opts);
  if ("response" in status) return status.response;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await req.text());
  } catch {
    return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: body is not valid JSON" } }, 400);
  }

  const aggregate = aggregateFor(opts, status.auth, status.fingerprint);

  // Batch (array): empty batch → single error; replies collected for entries
  // with ids, notifications dropped — an all-notification batch → 202.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: empty batch" } }, 400);
    }
    const replies: JsonRpcReply[] = [];
    for (const entry of parsed) {
      if (!isJsonRpcMessage(entry)) {
        replies.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: batch entry is not a JSON-RPC message" } });
        continue;
      }
      const outcome = await aggregate.handle(entry);
      if (outcome.kind === "reply") replies.push(outcome.message);
    }
    if (replies.length === 0) return acceptedResponse();
    return jsonRpcHttpResponse(replies);
  }

  if (!isJsonRpcMessage(parsed)) {
    return jsonRpcHttpResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON-RPC message or batch" } }, 400);
  }
  const outcome = await aggregate.handle(parsed);
  if (outcome.kind === "notification") return acceptedResponse();
  return jsonRpcHttpResponse(outcome.message);
}

function isJsonRpcMessage(v: unknown): v is JsonRpcMessage {
  return typeof v === "object" && v !== null && "method" in (v as Record<string, unknown>);
}

type RpcAuthResult = { ok: true; auth: OfficialMcpAuth; fingerprint: string } | { response: Response };

async function resolveAuthForRpc(opts: McpRouteOptions): Promise<RpcAuthResult> {
  let cred: Credential | null = null;
  try {
    cred = await opts.auth.getCredential();
  } catch {
    cred = null;
  }
  const status = resolveMcpAuth(cred, opts.config.plan);
  if (!status.ok) {
    const type = status.reason === "plan_unsupported" ? "mcp_plan_unsupported" : "mcp_credentials_unavailable";
    return { response: errorResponse(400, type, status.message) };
  }
  return status;
}

/** DELETE /mcp — close every cached upstream session, drop the aggregate. */
async function handleMcpClose(opts: McpRouteOptions): Promise<Response> {
  const status = await resolveAuthForRpc(opts);
  if ("response" in status) return status.response;
  if (cachedAggregate) {
    await cachedAggregate.server.closeAll();
    cachedAggregate = null;
  }
  return new Response(null, { status: 202 });
}

function jsonRpcHttpResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });
}

function acceptedResponse(): Response {
  return new Response(null, { status: 202 });
}

interface ListedServer {
  key: string;
  routeId: string;
  plugin: string;
  pluginVersion: string;
  requiresPaidPlan: boolean;
  displayName: Record<string, string>;
  description: Record<string, string>;
  category?: string;
}

interface ListingBody {
  generatedAt: string;
  upstreamOrigin: string;
  endpoint: string;
  authReady: boolean;
  authMode: string | null;
  authError: string | null;
  servers: ListedServer[];
}

/**
 * GET /mcp — human discovery (JSON; HTML for browsers). MCP clients asking
 * for an SSE stream (Accept includes text/event-stream) get 405 instead:
 * this aggregate never pushes server-initiated messages.
 */
async function handleMcpListing(req: Request, opts: McpRouteOptions): Promise<Response> {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  }

  const origin = opts.config.mcp.gateway.upstreamOrigin;
  let cred: Credential | null = null;
  try {
    cred = await opts.auth.getCredential();
  } catch {
    cred = null;
  }
  const status = resolveMcpAuth(cred, opts.config.plan);

  const servers: ListedServer[] = OFFICIAL_MCP_CATALOGUE.servers.map((s) => ({
    key: s.key,
    routeId: s.routeId,
    plugin: s.plugin,
    pluginVersion: s.version,
    requiresPaidPlan: s.requiresPaidPlan,
    displayName: s.displayName,
    description: s.description,
    ...(s.category ? { category: s.category } : {}),
  }));

  const body: ListingBody = {
    generatedAt: OFFICIAL_MCP_CATALOGUE.generatedAt,
    upstreamOrigin: origin,
    endpoint: "/mcp",
    authReady: status.ok,
    authMode: status.ok ? status.auth.mode : null,
    authError: status.ok ? null : status.reason,
    servers,
  };

  if (accept.includes("text/html")) {
    return new Response(renderListingHtml(body), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderListingHtml(body: ListingBody): string {
  const rows = body.servers
    .map((s) => {
      const name = s.displayName["zh-CN"] ?? s.displayName.en ?? s.key;
      const desc = s.description["zh-CN"] ?? s.description.en ?? "";
      return `      <tr><td><code>${escapeHtml(s.key)}</code></td><td>${escapeHtml(name)}</td><td>${escapeHtml(desc)}</td><td><code>${escapeHtml(s.routeId)}</code></td><td>${s.requiresPaidPlan ? "yes" : "no"}</td></tr>`;
    })
    .join("\n");
  const authLine = body.authReady
    ? `auth: <b>ready</b> (${escapeHtml(String(body.authMode))})`
    : `auth: <b>not ready</b> (${escapeHtml(String(body.authError))})`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>zcode-proxy · MCP endpoint</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}code{background:#f4f4f4;padding:0 .3rem}</style>
</head>
<body>
  <h1>MCP endpoint</h1>
  <p>One aggregated endpoint: <code>POST ${escapeHtml(body.endpoint)}</code> (streamable HTTP). Tools are named <code>{plugin}__{tool}</code>. Gateway: <code>${escapeHtml(body.upstreamOrigin)}</code> · catalogue: ${escapeHtml(body.generatedAt)} · ${authLine}</p>
  <table>
    <thead><tr><th>plugin key</th><th>name</th><th>description</th><th>route id</th><th>paid plan</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
