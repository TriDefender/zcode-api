/**
 * Bun.serve server setup with routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { OnboardJobManager } from "../auth/onboard-jobs.js";
import type { QuotaCache } from "../auth/quota-cache.js";
import { RequestLogStore } from "./request-logs.js";
import { handleChatCompletions, handleListModels, handleListModelCatalog, handleGetModel, handleGetModelInfo } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponses } from "./routes-responses.js";
import { handleAdminRoute } from "./routes-admin.js";
import { handleDashboard } from "./routes-web.js";
import { errorResponse } from "../proxy/handler.js";

export interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  accountPool?: AccountPool;
  onboardJobs?: OnboardJobManager;
  requestLogs?: RequestLogStore;
  quotaCache?: QuotaCache;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
}

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth, accountPool, onboardJobs, requestLogs, quotaCache } = opts;
  const proxyOpts = { config, auth, accountPool, requestLogs, fetchImpl: opts.fetchImpl };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (process.env.ZCODE_PROXY_LOG_REQUESTS === "1") {
      console.log(`[req] ${method} ${path}`);
    }

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // Web dashboard + admin API — no proxy key required
    if (path === "/app" || path === "/app/") {
      return handleDashboard(req);
    }

    // Browser root → dashboard
    if (path === "/" && method === "GET" && wantsHtml(req)) {
      return handleDashboard(req);
    }

    const isAdmin = path.startsWith("/admin/");
    const isProxyApi =
      path.startsWith("/v1/") ||
      path === "/responses";

    // Proxy API key protects LLM endpoints only — dashboard + /admin are open locally
    if (isProxyApi && config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }

    // --- Routing ---

    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if ((path === "/v1/responses" || path === "/responses") && method === "POST") {
      return handleResponses(req, proxyOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels();
    }
    if (path === "/v1/models/catalog" && method === "GET") {
      return handleListModelCatalog();
    }
    const modelInfoMatch = path.match(/^\/v1\/models\/([^/]+)\/info$/);
    if (modelInfoMatch && method === "GET") {
      return handleGetModelInfo(decodeURIComponent(modelInfoMatch[1]!));
    }
    const modelMatch = path.match(/^\/v1\/models\/([^/]+)$/);
    if (modelMatch && method === "GET") {
      return handleGetModel(decodeURIComponent(modelMatch[1]!));
    }

    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    if (path === "/health" || (path === "/" && method === "GET")) {
      const poolInfo =
        accountPool && config.plan === "start-plan"
          ? { pool: { total: accountPool.size(), active: accountPool.activeCount() } }
          : {};
      return new Response(JSON.stringify({ status: "ok", provider: config.provider, ...poolInfo }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (isAdmin && accountPool && onboardJobs && requestLogs) {
      return handleAdminRoute(req, { accountPool, config, onboardJobs, requestLogs, quotaCache });
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(opts);
  const { port, host } = opts.config.server;

  return Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0,
    fetch(req) {
      return handler(req).then((resp) => addCorsHeaders(resp));
    },
  });
}

function checkProxyKey(authHeader: string, expected: string): boolean {
  const trimmed = authHeader.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim() === expected;
  }
  return trimmed === expected;
}

function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function addCorsHeaders(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
  };
}
