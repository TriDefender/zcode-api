/**
 * HTTP server bootstrap with routing and proxy API key auth.
 *
 * Replaces the original `Bun.serve` adapter with `node:http.createServer` so
 * the same code runs on Bun (dev mode, source TS) and on Node (Android bundle).
 * Bun supports `node:http` natively; Node has no `Bun.serve` equivalent.
 *
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
import { handleMcpRoute, type McpRouteOptions } from "./routes-mcp.js";
import {
  handleAsrFlash,
  handleAsrSubmitQueryUnsupported,
  handleImagesGenerations,
  handleTtsCreate,
  handleVideoTaskCreate,
  handleVideoTaskDelete,
  handleVideoTaskQuery,
  type MediaRouteOptions,
} from "./routes-media.js";
import { handleQuota } from "./routes-quota.js";
import { errorResponse } from "../proxy/handler.js";
import { arkErrorResponse } from "../media/shared.js";
import type { ResponseStore } from "../responses/store.js";
import { handleLoginApi, loginPageResponse, type LoginFlowHost } from "./login-handler.js";

interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** When true, enable per-request debug diagnostics in the proxy handler. */
  debug?: boolean;
  /** Responses-API state store. When absent, `/v1/responses` runs stateless (`previous_response_id` returns 404). */
  responseStore?: ResponseStore;
  /** Media routes: ToolHub same-key retry backoff (production 5s; tests ~1ms). */
  mediaRetryDelayMs?: number;
  /**
   * `/login` selection-page backend (serve mode). When absent the `/login`
   * routes are not registered at all — the TUI hosts the same page on its own
   * temporary listener instead.
   */
  loginHost?: LoginFlowHost;
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
  const mcpOpts: McpRouteOptions = {
    config,
    auth,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const mediaOpts: MediaRouteOptions = {
    config,
    auth,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.mediaRetryDelayMs !== undefined ? { retryDelayMs: opts.mediaRetryDelayMs } : {}),
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const cors = corsHeaders(Boolean(config.auth.proxyApiKey));

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse(cors);
    }

    if (method === "GET" && (path === "/webui" || path.startsWith("/webui/"))) {
      return new Response(webuiHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // /login selection page: static HTML is tokenless (like /webui — the page
    // itself is inert), but the flow endpoints below sit AFTER the proxyApiKey
    // gate: a completed login overwrites the stored credential, so starting
    // one must never be unauthenticated.
    if (opts.loginHost && method === "GET" && path === "/login") {
      const page = loginPageResponse();
      return new Response(page.html, {
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

    if (opts.loginHost && (path === "/login/start" || path === "/login/status")) {
      // Body cap mirroring the TUI listener's 8KB limit (login-handler.ts
      // readBodyText): /login/start only ever carries `{provider}`. The
      // content-length precheck answers 413 before reading; a lying header is
      // caught by the post-read check and surfaces as the handler's 400.
      const declaredLength = Number(req.headers.get("content-length") ?? "0");
      if (method === "POST" && Number.isFinite(declaredLength) && declaredLength > 8192) {
        return new Response(JSON.stringify({ ok: false, error: "body_too_large" }), {
          status: 413,
          headers: { "content-type": "application/json" },
        });
      }
      const { status, json } = await handleLoginApi(method, path, async () => {
        const body = await req.text();
        if (body.length > 8192) throw new Error("body_too_large");
        return body;
      }, opts.loginHost);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
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

    if (config.mcp.gateway.enabled) {
      // Aggregated MCP endpoint: ONE `/mcp` URL exposes every official
      // plugin's tools (streamable HTTP — POST JSON-RPC, GET listing,
      // DELETE session close). Replaces the per-plugin `/mcp/{key}` relay.
      if (path === "/mcp" && (method === "POST" || method === "GET" || method === "DELETE")) {
        return handleMcpRoute(req, mcpOpts);
      }
    }

    if (config.media.enabled) {
      // Seed-family media faces — Volcano-shaped REST endpoints translated to
      // the ToolHub / official video_edit MCP upstreams (coding-plan only;
      // the handlers enforce the plan gate with an explicit 400).
      if (path === "/api/v3/images/generations" && method === "POST") {
        return handleImagesGenerations(req, mediaOpts);
      }
      if (path === "/api/v3/contents/generations/tasks" && method === "POST") {
        return handleVideoTaskCreate(req, mediaOpts);
      }
      const taskId = path.startsWith("/api/v3/contents/generations/tasks/")
        ? decodeTaskIdSegment(path.slice("/api/v3/contents/generations/tasks/".length))
        : undefined;
      if (taskId !== undefined && (method === "GET" || method === "DELETE")) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
          return arkErrorResponse(400, "invalid_parameter", "task id must be 1-128 characters of [A-Za-z0-9_-]");
        }
        if (method === "GET") return handleVideoTaskQuery(mediaOpts, taskId);
        return handleVideoTaskDelete(mediaOpts);
      }
      if (path === "/api/v3/auc/bigmodel/recognize/flash" && method === "POST") {
        return handleAsrFlash(req, mediaOpts);
      }
      // Official async ASR pair — sync-only upstream, 501 with the alternative.
      if ((path === "/api/v3/auc/bigmodel/submit" || path === "/api/v3/auc/bigmodel/query") && method === "POST") {
        return handleAsrSubmitQueryUnsupported();
      }
      if (path === "/api/v3/tts/create" && method === "POST") {
        return handleTtsCreate(req, mediaOpts);
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
 * Decode the task-id path segment, falling back to the RAW segment on a
 * malformed percent-sequence: decodeURIComponent throws URIError for `%`,
 * `%80`, `%zz` (verified on the pinned Bun 1.4.0), and letting that escape
 * the router would surface as a 500 that bypasses the route's own Ark 400
 * validation. The raw fallback keeps every invalid character, so the
 * `^[A-Za-z0-9_-]{1,128}$` guard below rejects it with the intended 400.
 */
function decodeTaskIdSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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
  const cors = corsHeaders(Boolean(opts.config.auth.proxyApiKey));

  const server: Server = createServer(async (req, res) => {
    const abortController = new AbortController();
    const onClientClose = (): void => {
      if (!res.writableEnded) abortController.abort();
    };
    res.on("close", onClientClose);

    // `/async/*` routes can hold the connection open for minutes-to-hours while
    // waiting for an off-peak ticket. Lift the per-request socket timeout from
    // the default 600s (set below via server.requestTimeout) to 24h so the long
    // queue wait + LLM stream doesn't get killed mid-flight. `/mcp/*` GET SSE
    // streams are equally long-lived. `/api/v3/*` media faces block on the
    // speech/video/image upstreams (flash ASR legitimately runs minutes on
    // long audio). Other routes keep the default timeout.
    const pathForTimeout = req.url ?? "";
    if (
      pathForTimeout.startsWith("/async/") ||
      pathForTimeout.startsWith("/mcp/") ||
      pathForTimeout.startsWith("/api/v3/")
    ) {
      req.setTimeout(24 * 60 * 60 * 1000);
    }

    try {
      const webReq = nodeReqToWebRequest(req, abortController.signal);
      const resp = await handler(webReq).then((r) => addCorsHeaders(r, cors));
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
function corsResponse(cors: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: cors,
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response, cors: Record<string, string>): Response {
  if (Object.keys(cors).length === 0) return resp;
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/**
 * CORS headers are emitted ONLY when `auth.proxyApiKey` is set.
 *
 * Rationale: the /mcp relay (and /v1/*) inject the operator's real OAuth
 * credentials upstream; with `access-control-allow-origin: *` on a keyless
 * deployment, any webpage in a logged-in user's browser could pass preflight
 * and drive those routes cross-origin (MCP JSON POSTs are preflighted, so
 * withholding the headers blocks the browser before the request fires).
 * Local CLI/curl tools and the same-origin /webui never needed CORS.
 */
function corsHeaders(corsEnabled: boolean): Record<string, string> {
  if (!corsEnabled) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, x-api-request-id, x-api-resource-id, anthropic-version, anthropic-beta, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, x-api-request-id, x-api-status-code",
    "access-control-max-age": "86400",
  };
}
