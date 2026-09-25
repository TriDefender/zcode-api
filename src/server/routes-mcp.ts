/**
 * Official plugin-MCP route handlers: `GET /mcp` (endpoint listing) and
 * `/mcp/{server}` (streamable-HTTP relay to Z.AI's official gateway).
 *
 * Inbound auth is the shared proxyApiKey gate in `server.ts::createFetchHandler`
 * (same semantics as the LLM routes); outbound auth is the stored OAuth
 * credential via `src/mcp/relay.ts` (coding-plan only — the gateway rejects
 * identity-only credentials with JSON-RPC 3101, so start-plan gets an explicit
 * 400 here, mirroring the async-route pattern).
 *
 * Route registration lives in `server.ts` (gated by `config.mcp.gateway.enabled`).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"
 */
import {
  buildOfficialMcpAuthHeaders,
  relayOfficialMcpRequest,
  McpCredentialsUnavailableError,
  type OfficialMcpAuth,
  type McpCredentialReason,
} from "../mcp/relay.js";
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

export type McpAuthStatus =
  | { ok: true; auth: OfficialMcpAuth }
  | { ok: false; reason: McpCredentialReason | "not_logged_in" | "plan_unsupported"; message: string };

function resolveMcpAuth(cred: Credential | null, plan: ProxyConfig["plan"]): McpAuthStatus {
  if (plan !== "coding-plan") {
    return {
      ok: false,
      reason: "plan_unsupported",
      message: `official MCP endpoints require plan "coding-plan" (current plan: ${plan})`,
    };
  }
  if (!cred) {
    return {
      ok: false,
      reason: "not_logged_in",
      message: "not logged in — run: zcode-proxy auth login <zai|bigmodel>",
    };
  }
  try {
    return { ok: true, auth: buildOfficialMcpAuthHeaders(cred) };
  } catch (err) {
    if (err instanceof McpCredentialsUnavailableError) {
      return { ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

interface ListedServer {
  key: string;
  path: string;
  methods: string[];
  routeId: string;
  plugin: string;
  pluginVersion: string;
  requiresPaidPlan: boolean;
  displayName: Record<string, string>;
  description: Record<string, string>;
  category?: string;
}

/** GET /mcp — what is being served right now (JSON; HTML table for browsers). */
export async function handleMcpListingRoute(req: Request, opts: McpRouteOptions): Promise<Response> {
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
    path: `/mcp/${s.key}`,
    methods: ["POST", "GET", "DELETE"],
    routeId: s.routeId,
    plugin: s.plugin,
    pluginVersion: s.version,
    requiresPaidPlan: s.requiresPaidPlan,
    displayName: s.displayName,
    description: s.description,
    ...(s.category ? { category: s.category } : {}),
  }));

  const body = {
    object: "list",
    generatedAt: OFFICIAL_MCP_CATALOGUE.generatedAt,
    upstreamOrigin: origin,
    authReady: status.ok,
    authMode: status.ok ? status.auth.mode : null,
    authError: status.ok ? null : status.reason,
    servers,
  };

  const accept = req.headers.get("accept") ?? "";
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

/** Any of POST/GET/DELETE /mcp/{server} — relay to the official gateway. */
export async function handleMcpRelayRoute(req: Request, serverKey: string, opts: McpRouteOptions): Promise<Response> {
  const def = OFFICIAL_MCP_CATALOGUE.servers.find((s) => s.key === serverKey);
  if (!def) {
    return errorResponse(404, "mcp_server_not_found", `Unknown MCP server "${serverKey}" — see GET /mcp for the served endpoints`);
  }
  if (opts.config.plan !== "coding-plan") {
    return errorResponse(
      400,
      "mcp_plan_unsupported",
      `official MCP endpoints require plan "coding-plan" (current plan: ${opts.config.plan})`,
    );
  }

  let cred: Credential;
  try {
    cred = await opts.auth.getCredential();
  } catch (err) {
    return errorResponse(400, "mcp_credentials_unavailable", (err as Error).message);
  }
  let auth: OfficialMcpAuth;
  try {
    auth = buildOfficialMcpAuthHeaders(cred);
  } catch (err) {
    if (err instanceof McpCredentialsUnavailableError) {
      return errorResponse(400, "mcp_credentials_unavailable", err.message);
    }
    throw err;
  }

  const incoming = new URL(req.url);
  const upstreamUrl = `${opts.config.mcp.gateway.upstreamOrigin}${def.path}${incoming.search}`;
  const { response } = await relayOfficialMcpRequest(req, auth, upstreamUrl, opts.fetchImpl);
  return response;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface ListingBody {
  generatedAt: string;
  upstreamOrigin: string;
  authReady: boolean;
  authMode: string | null;
  authError: string | null;
  servers: ListedServer[];
}

function renderListingHtml(body: ListingBody): string {
  const rows = body.servers
    .map((s) => {
      const name = s.displayName["zh-CN"] ?? s.displayName.en ?? s.key;
      const desc = s.description["zh-CN"] ?? s.description.en ?? "";
      return `      <tr><td><a href="${escapeHtml(s.path)}">${escapeHtml(s.key)}</a></td><td>${escapeHtml(name)}</td><td>${escapeHtml(desc)}</td><td><code>${escapeHtml(s.routeId)}</code></td><td>${s.requiresPaidPlan ? "yes" : "no"}</td></tr>`;
    })
    .join("\n");
  const authLine = body.authReady
    ? `auth: <b>ready</b> (${escapeHtml(String(body.authMode))})`
    : `auth: <b>not ready</b> (${escapeHtml(String(body.authError))})`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>zcode-proxy · MCP endpoints</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}code{background:#f4f4f4;padding:0 .3rem}</style>
</head>
<body>
  <h1>MCP endpoints</h1>
  <p>${authLine} · gateway: <code>${escapeHtml(body.upstreamOrigin)}</code> · catalogue: ${escapeHtml(body.generatedAt)}</p>
  <table>
    <thead><tr><th>endpoint</th><th>name</th><th>description</th><th>route id</th><th>paid plan</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
