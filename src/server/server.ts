/**
 * HTTP server bootstrap with routing and proxy API key auth.
 *
 * Replaces the original `Bun.serve` adapter with `node:http.createServer` so
 * the same code runs on Bun (dev mode, source TS) and on Node (Android bundle).
 * Bun supports `node:http` natively; Node has no `Bun.serve` equivalent.
 *
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import webuiHtml from "./webui.txt" with { type: "text" };
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponsesRoute } from "./routes-responses.js";
import { handleAsyncMessagesRoute, handleAsyncChatRoute, handleAsyncHealthRoute } from "./routes-async.js";
import { handleQuota } from "./routes-quota.js";
import { errorResponse } from "../proxy/handler.js";
import type { ResponseStore } from "../responses/store.js";

interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** When true, enable per-request debug diagnostics in the proxy handler. */
  debug?: boolean;
  /** Responses-API state store. When absent, `/v1/responses` runs stateless (`previous_response_id` returns 404). */
  responseStore?: ResponseStore;
}

/** Minimal server handle: what the caller needs to print URLs and shut down. */
export interface ProxyServer {
  hostname: string;
  port: number;
  /** Close the server. When `exit` is true, also call `process.exit(0)`. */
  stop(exit?: boolean): void;
  /** Promise that resolves once the server has fully stopped. */
  close(): Promise<void>;
}

/** Create a fetch-style handler that routes the request through the proxy. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl, debug: opts.debug === true };
  const responsesOpts = {
    config,
    auth,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
    ...(opts.responseStore ? { responseStore: opts.responseStore } : {}),
  };
  const asyncOpts = {
    config,
    auth,
    fetchImpl: opts.fetchImpl,
    debug: opts.debug === true,
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    if (method === "GET" && (path === "/webui" || path.startsWith("/webui/"))) {
      return new Response(webuiHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
      }
    }

    // --- Routing ---

    if (path === "/v1/chat/completions" && method === "POST") {
      return handleChatCompletions(req, proxyOpts);
    }
    if (config.responses.enabled && path === "/v1/responses" && method === "POST") {
      return handleResponsesRoute(req, responsesOpts);
    }
    if (path === "/v1/models" && method === "GET") {
      return handleListModels(req);
    }

    if (path === "/quota" && method === "GET") {
      return handleQuota(config, opts.fetchImpl);
    }

    if (path === "/v1/messages" && method === "POST") {
      return handleMessages(req, proxyOpts);
    }

    if (config.async.enabled) {
      // Off-peak is a coding-plan feature: on start-plan the async routes are
      // disabled even when async.enabled=true (explicit error, not a silent 404).
      const isAsyncRoute =
        (path === "/async/v1/messages" && method === "POST") ||
        (path === "/async/v1/chat/completions" && method === "POST") ||
        (path === "/async/v1/health" && method === "GET");
      if (isAsyncRoute && config.plan !== "coding-plan") {
        return errorResponse(
          400,
          "async_plan_unsupported",
          `async (off-peak) endpoints are only available with plan "coding-plan" (current plan: ${config.plan})`,
        );
      }
      if (path === "/async/v1/messages" && method === "POST") {
        return handleAsyncMessagesRoute(req, asyncOpts);
      }
      if (path === "/async/v1/chat/completions" && method === "POST") {
        return handleAsyncChatRoute(req, asyncOpts);
      }
      if (path === "/async/v1/health" && method === "GET") {
        return handleAsyncHealthRoute(req, asyncOpts);
      }
    }

    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ status: "ok", provider: config.provider }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return errorResponse(404, "not_found_error", `No route for ${method} ${path}`);
  };
}

/**
 * Start the HTTP server. Resolves once the listener is bound; the returned
 * `ProxyServer.stop()` closes the underlying `node:http.Server`.
 *
 * `idleTimeout: 0` (the original Bun.serve setting for self-hosted long
 * reasoning calls) is mirrored by zeroing Node's request/keep-alive/headers
 * timeouts.
 */
export function startServer(opts: ServerOptions): Promise<ProxyServer> {
  const handler = createFetchHandler(opts);
  const { port: requestedPort, host } = opts.config.server;

  const server: Server = createServer(async (req, res) => {
    const abortController = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", onClientClose);

    // `/async/*` routes can hold the connection open for minutes-to-hours while
    // waiting for an off-peak ticket. Lift the per-request socket timeout from
    // the default 600s (set below via server.requestTimeout) to 24h so the long
    // queue wait + LLM stream doesn't get killed mid-flight. Non-async routes
    // keep the default timeout.
    if ((req.url ?? "").startsWith("/async/")) {
      req.setTimeout(24 * 60 * 60 * 1000);
    }

    try {
      const webReq = nodeReqToWebRequest(req, abortController.signal);
      const resp = await handler(webReq).then((r) => addCorsHeaders(r));
      await writeWebResponseToNodeResp(resp, res, abortController.signal);
    } catch (err) {
      if (abortController.signal.aborted) return;
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal_error", message: (err as Error).message } }));
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  // Disable all Node HTTP server timeouts to match Bun's `idleTimeout: 0`.
  // Long LLM reasoning calls (60-120s before first token) would otherwise
  // be killed by Node's defaults.
  server.requestTimeout = 600_000;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 600_000;

  return new Promise<ProxyServer>((resolve, reject) => {
    server.on("error", reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
      resolve({
        hostname: host,
        port: actualPort,
        stop: (exit) => {
          server.close();
          if (exit) process.exit(0);
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Convert a Node.js IncomingMessage to a Web API Request. */
function nodeReqToWebRequest(req: import("node:http").IncomingMessage, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else {
      headers.set(key, val);
    }
  }
  const host = headers.get("host") ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers, signal });
  }

  // Cast: Node's ReadableStream type ≠ Web ReadableStream type at the type layer, but `Readable.toWeb` returns a spec-compliant stream at runtime.
  const bodyStream = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: bodyStream,
    duplex: "half",
    signal,
  };
  return new Request(url, init);
}

/** Write a Web API Response to a Node.js ServerResponse. */
async function writeWebResponseToNodeResp(resp: Response, res: import("node:http").ServerResponse, abortSignal?: AbortSignal): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  resp.headers.forEach((value, key) => {
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (typeof existing === "string") {
      headers[key] = [existing, value];
    } else {
      existing.push(value);
    }
  });

  res.writeHead(resp.status, resp.statusText, headers);

  if (resp.body == null) {
    res.end();
    return;
  }

  const reader = resp.body.getReader();
  const onAbort = (): void => { reader.cancel().catch(() => {}); };
  abortSignal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
    res.end();
  } catch (err) {
    if (abortSignal?.aborted) {
      try { res.end(); } catch {}
    } else {
      try { res.destroy(err as Error); } catch {}
    }
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Check whether the client provided the correct proxy API key.
 * Constant-time comparison (audit R2-10): a plain `===` on the presented vs
 * expected key is a timing side channel on public-network deployments
 * (default bind is 0.0.0.0). Behavior is unchanged for honest callers.
 */
function checkProxyKey(authHeader: string, expected: string): boolean {
  const trimmed = authHeader.trim();
  const presented = trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
