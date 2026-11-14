/**
 * `/login` provider-selection page — the browser-side login surface shared by
 * the TUI (temporary loopback listener opened by the `l` key) and the serve
 * mode main server (tokenless static page + proxyApiKey-gated flow endpoints).
 *
 * The user picks a login flavor (zai international / zai_cn China / bigmodel);
 * the page jumps to the server-issued authorize URL and polls `/login/status`
 * while the server-mediated poll flow (auth/oauth.ts `startOAuthWithPolling`
 * mirror) completes in the background — the browser never calls back here.
 *
 * Flavor semantics (NOTEPAD「2026-11-14 增补」): `zai_cn` is the desktop 3.18.2
 * "Z.ai (CN)" login flavor — `cli/init {provider:"zai_cn"}` issues the
 * zchat.z.ai authorize host directly, `zai` keeps the chat.z.ai chain (CN
 * browsers region-bounce to zchat with the same OAuth params), and both fold
 * into the zai credential family downstream.
 *
 * Security: on the main server the flow endpoints sit behind the shared
 * proxyApiKey gate (server.ts route order) — a completed login overwrites the
 * stored credential, so the start endpoint must never be tokenless there. The
 * TUI temporary listener is loopback-only, ephemeral, and dies with the flow.
 *
 * @see _reverse/NOTEPAD.md "2026-11-14 增补"
 */
import loginPageHtml from "./login-page.txt" with { type: "text" };
import { createPollLoginClient, type FetchFn, type OAuthFlowClient, type OAuthFlowTokens } from "../auth/oauth.js";
import type { LoginProviderId } from "../provider/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** Phases surfaced on `/login/status`; `ready`/`failed` are terminal. */
export type LoginPhase = "idle" | "authorizing" | "ready" | "failed";

export interface LoginStatus {
  phase: LoginPhase;
  provider?: LoginProviderId;
  /** Failure detail for `phase:"failed"` (resolver errors, timeouts, poll rejection). */
  error?: string;
}

/**
 * Backend seam consumed by `handleLoginApi`. Two implementations: the
 * in-process poll host (`createPollLoginHost`, TUI temporary listener) and a
 * thin wrapper over the control dispatcher's `startOAuth`/`status` commands
 * (serve mode, wired in index.ts).
 */
export interface LoginFlowHost {
  start(provider: LoginProviderId): Promise<{ authorizeUrl: string }>;
  status(): Promise<LoginStatus>;
}

const LOGIN_PROVIDER_SET = new Set<LoginProviderId>(["zai", "zai_cn"]);
// bigmodel OAuth login is deprecated (superseded by zai_cn; decision 2026-11-14) —
// the flavor survives as a config/credential family only.

/**
 * In-process poll-flow host (TUI temporary listener): runs the OAuth poll
 * client to completion in the background and funnels tokens into `onTokens`
 * (which resolves the API key and saves the credential). A throw out of
 * `onTokens` (resolver/network failures) marks the flow failed on the page.
 * `onDone` fires once per flow AFTER the terminal status is set (so a status
 * poll sees ready/failed before the teardown it triggers).
 */
export function createPollLoginHost(opts: {
  onTokens: (provider: LoginProviderId, tokens: OAuthFlowTokens) => Promise<void>;
  /** Terminal notification — success passes `null`, failure the error message. */
  onDone?: (provider: LoginProviderId, error: string | null) => void;
  fetchImpl?: FetchFn;
  /** Injectable poll pause (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}): LoginFlowHost & { close(): Promise<void> } {
  let active: { client: OAuthFlowClient; status: LoginStatus } | null = null;

  return {
    async start(provider: LoginProviderId): Promise<{ authorizeUrl: string }> {
      if (active?.status.phase === "authorizing") {
        throw new Error("login_already_in_progress");
      }
      // A terminal (ready/failed) leftover still holds its client — release it.
      if (active) {
        void active.client.close().catch(() => {});
        active = null;
      }
      const client = createPollLoginClient(provider, opts.fetchImpl, opts.sleep);
      const started = await client.start();
      active = { client, status: { phase: "authorizing", provider } };
      const current = active;
      void (async () => {
        let doneError: string | null = null;
        try {
          const tokens = await client.complete(started);
          await opts.onTokens(provider, tokens);
          if (active === current) current.status = { phase: "ready", provider };
        } catch (err) {
          doneError = (err as Error)?.message ?? String(err);
          if (active === current) {
            current.status = { phase: "failed", provider, error: doneError };
          }
        } finally {
          void client.close().catch(() => {});
          if (active === current) opts.onDone?.(provider, doneError);
        }
      })();
      return { authorizeUrl: started.authorizeUrl };
    },

    async status(): Promise<LoginStatus> {
      return active?.status ?? { phase: "idle" };
    },

    async close(): Promise<void> {
      if (active) {
        void active.client.close().catch(() => {});
        active = null;
      }
    },
  };
}

/** Static `/login` page payload (200, text/html; no-cache like /webui). */
export function loginPageResponse(): { status: 200; html: string } {
  return { status: 200, html: loginPageHtml };
}

/**
 * Shared `/login` flow API, transport-agnostic so both the main server (Web
 * Request) and the TUI temporary listener (node:http) can drive it. `path` is
 * the raw pathname (`/login/start`, `/login/status`); errors are in-band
 * `{ok:false,error}` (control-protocol convention) — the page JS renders them.
 */
export async function handleLoginApi(
  method: string,
  path: string,
  readBody: () => Promise<string>,
  host: LoginFlowHost,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (method === "POST" && path === "/login/start") {
    let provider: unknown;
    try {
      provider = (JSON.parse(await readBody()) as { provider?: unknown }).provider;
    } catch {
      return { status: 400, json: { ok: false, error: "invalid_json" } };
    }
    if (typeof provider !== "string" || !LOGIN_PROVIDER_SET.has(provider as LoginProviderId)) {
      return { status: 400, json: { ok: false, error: "invalid_provider" } };
    }
    try {
      const { authorizeUrl } = await host.start(provider as LoginProviderId);
      return { status: 200, json: { ok: true, authorizeUrl } };
    } catch (err) {
      return { status: 200, json: { ok: false, error: (err as Error)?.message ?? String(err) } };
    }
  }

  if (method === "GET" && path === "/login/status") {
    const status = await host.status();
    return { status: 200, json: { ok: true, ...status } };
  }

  return { status: 404, json: { ok: false, error: "not_found" } };
}

export interface LoginServerHandle {
  /** `http://127.0.0.1:<port>/login` — what the TUI opens in the browser. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Temporary loopback listener hosting the `/login` page (TUI `l` key). Binds
 * 127.0.0.1 on an ephemeral port with a per-request remoteAddress re-check —
 * the same two-layer loopback discipline as the android control listener. The
 * caller owns the lifetime: close it on teardown, on completion grace, or on
 * flow timeout.
 */
export function startLoginServer(host: LoginFlowHost): Promise<LoginServerHandle> {
  return new Promise((resolve, reject) => {
    // node:http (not Bun.serve) — same Android embedded-Node constraint as
    // server.ts / control.ts.
    const server = createServer((nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
      const remote = nodeReq.socket.remoteAddress ?? "";
      if (!isLoopbackAddress(remote)) {
        nodeRes.writeHead(403, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
      }
      const url = new URL(nodeReq.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (nodeReq.method === "GET" && (path === "/login" || path === "/" || path === "/login/")) {
        nodeRes.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        nodeRes.end(loginPageHtml);
        return;
      }
      handleLoginApi(nodeReq.method ?? "GET", path, () => readBodyText(nodeReq), host)
        .then(({ status, json }) => {
          nodeRes.writeHead(status, { "content-type": "application/json" });
          nodeRes.end(JSON.stringify(json));
        })
        .catch(() => {
          // Never let a handler throw kill the listener mid-login.
          nodeRes.writeHead(500, { "content-type": "application/json" });
          nodeRes.end(JSON.stringify({ ok: false, error: "internal_error" }));
        });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("login listener: unexpected address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/login`,
        port: address.port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function readBodyText(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 8192) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isLoopbackAddress(remote: string): boolean {
  // IPv4 loopback (127.0.0.0/8) and IPv6 loopback/compressed forms; node may
  // report "::1", "::ffff:127.0.0.1", or the raw IPv4 string.
  return remote === "::1" || remote === "::ffff:127.0.0.1" || /^127\./.test(remote);
}
