/**
 * Bun.serve server setup with routing and proxy API key auth.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { errorResponse } from "../proxy/handler.js";

interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** When true, enable per-request debug diagnostics in the proxy handler. */
  debug?: boolean;
}

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl, debug: opts.debug === true };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // Proxy API key auth (if configured)
    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }

    // --- Routing ---

    // OpenAI routes
    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels();
    }

    // Anthropic routes
    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    // Health check
    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ status: "ok", provider: config.provider }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(opts);
  const { port, host } = opts.config.server;

  return Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // 自用代理：禁用空闲超时，避免长 reasoning 的 LLM 请求被杀
    fetch(req) {
      // Add CORS headers to all responses
      return handler(req).then((resp) => addCorsHeaders(resp));
    },
  });
}

/** Check whether the client provided the correct proxy API key. */
function checkProxyKey(authHeader: string, expected: string): boolean {
  // Accept "Bearer {key}" or bare key
  const trimmed = authHeader.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim() === expected;
  }
  // Also accept x-api-key: {key}
  return trimmed === expected;
}

/** Build a CORS preflight response. */
function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

/** Add CORS headers to an existing response (non-mutating). */
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
  };
}
