/**
 * Optional web panel for headless deployments (issue #58).
 *
 * `serve` has no TUI, and inside Docker there is no terminal to render one
 * into — today the only way to see quota, switch provider/plan or read live
 * logs is `docker exec` plus hand-editing `config.yaml` and restarting. This
 * module exposes the *existing* localhost control protocol
 * (`src/android/control.ts`, already used by the Android shell) through a
 * token-guarded HTTP surface plus one embedded page. It adds no new state and
 * no new upstream calls:
 *
 *   browser → panel (token) → POST /api/control → in-process dispatcher
 *
 * The dispatcher is `createControlDispatcher()` from `src/android/control.ts`:
 * the same command semantics `POST /control` serves, called directly instead of
 * over a second loopback HTTP port. Opening such a port would mean an
 * unauthenticated path to `stopProxy` / `logout` / `shutdown` for anything that
 * can reach loopback (a browser on the box can POST `text/plain` cross-origin
 * without reading the response), so the panel does not do it.
 *
 * Security model (deliberate, see the discussion on #58):
 *  - off by default: `ZCODE_PANEL_ENABLED` must be set to a truthy value;
 *  - a non-empty `ZCODE_PANEL_TOKEN` is mandatory — no token, no listener;
 *  - binds loopback by default (`ZCODE_PANEL_HOST` can override, e.g. `0.0.0.0`
 *    for Docker bridge networks — the token stays mandatory), and never
 *    touches `auth.proxyApiKey` or `/v1/*`,
 *    so enabling the panel does not change the proxy's own auth surface;
 *  - `/api/*` requires `Authorization: Bearer <token>` or `X-Panel-Token`,
 *    compared with `timingSafeEqual`, and a body above `MAX_BODY_BYTES` is
 *    rejected before it is parsed;
 *  - `GET /` and `GET /healthz` are tokenless because a browser cannot attach
 *    a header to a top-level navigation: `/` returns the static shell (no
 *    account data) and `/healthz` returns a fixed `{"ok":true}`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ControlCommand, ControlResponse } from "../android/control.js";
import panelHtml from "./panel-page.txt" with { type: "text" };

/** Env flag that enables the panel. Empty / `0` / `false` / `no` / `off` = off. */
export const PANEL_ENABLED_ENV = "ZCODE_PANEL_ENABLED";
/** Shared secret for `/api/*`. Required whenever the panel is enabled. */
export const PANEL_TOKEN_ENV = "ZCODE_PANEL_TOKEN";
/** Panel listen port. */
export const PANEL_PORT_ENV = "ZCODE_PANEL_PORT";
/**
 * Panel bind address. Loopback unless explicitly overridden — the supported
 * escape hatch is `0.0.0.0` so Docker bridge `-p 8090:8090` can reach a panel
 * bound inside the container (the token remains mandatory).
 */
export const PANEL_HOST_ENV = "ZCODE_PANEL_HOST";

/** Defaults mirror the Android entry's wiring so operators only set one thing. */
export const DEFAULT_PANEL_PORT = 8090;
export const DEFAULT_PANEL_HOST = "127.0.0.1";

/** Control commands are small JSON documents; anything bigger is a mistake. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * In-process control dispatch: `POST /api/control` hands the parsed command to
 * this and returns whatever the control protocol answers, unchanged.
 */
export type ControlDispatcher = (cmd: ControlCommand) => Promise<ControlResponse>;

export interface PanelOptions {
  /** HTTP port. `0` picks a free port (used by tests). */
  port: number;
  /** Shared secret required on `/api/*`; must be non-empty. */
  token: string;
  /** In-process dispatcher backing `POST /api/control`. */
  handleControl: ControlDispatcher;
  /** Bind address; loopback unless `ZCODE_PANEL_HOST` overrides it. */
  hostname?: string;
}

/** Handle for a running panel; `close()` releases the port. */
export interface PanelServer {
  hostname: string;
  port: number;
  close(): Promise<void>;
}

/** Fully resolved panel settings; only produced when the panel should run. */
export interface PanelSettings {
  token: string;
  port: number;
  host: string;
}

/** Request handler produced by {@link createPanelHandler}. */
export type PanelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * True when `ZCODE_PANEL_ENABLED` asks for the panel. Kept deliberately strict
 * and case-insensitive so `ZCODE_PANEL_ENABLED=0`/`false` stay off.
 */
export function isPanelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PANEL_ENABLED_ENV] ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/**
 * Resolve the panel configuration from the environment. Returns `null` when the
 * panel must not start — either it was not requested, or it was requested
 * without a token, which is a configuration mistake worth a loud message rather
 * than an unauthenticated listener.
 */
export function resolvePanelSettings(env: NodeJS.ProcessEnv = process.env): PanelSettings | null {
  if (!isPanelEnabled(env)) return null;

  const token = (env[PANEL_TOKEN_ENV] ?? "").trim();
  if (!token) {
    console.error(`[panel] ${PANEL_ENABLED_ENV} is set but ${PANEL_TOKEN_ENV} is empty — panel not started`);
    return null;
  }

  const port = Number(env[PANEL_PORT_ENV] ?? DEFAULT_PANEL_PORT) || DEFAULT_PANEL_PORT;
  const host = (env[PANEL_HOST_ENV] ?? DEFAULT_PANEL_HOST).trim() || DEFAULT_PANEL_HOST;
  return { token, port, host };
}

/** First value of a possibly-repeated request header. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Constant-time token comparison (only the length is revealed). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accept either `Authorization: Bearer <token>` or `X-Panel-Token: <token>`. */
function extractToken(req: IncomingMessage): string | undefined {
  const direct = headerValue(req.headers["x-panel-token"]);
  if (direct) return direct.trim();
  const auth = headerValue(req.headers["authorization"]);
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * Read the request body, rejecting anything above {@link MAX_BODY_BYTES}.
 * The oversized case keeps draining the socket before answering: replying
 * while the client is still writing can reset the connection and lose the 413.
 * Returns `null` when the body is too large.
 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buf);
  }
  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the panel request handler. Exported separately from
 * {@link startPanelServer} so tests can drive it without binding a port.
 */
export function createPanelHandler(opts: PanelOptions): PanelHandler {
  const token = opts.token;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    // Static shell + liveness: tokenless by design (see the file header).
    if (method === "GET" && (path === "/" || path === "/panel")) {
      sendHtml(res, panelHtml);
      return;
    }
    if (method === "GET" && (path === "/healthz" || path === "/api/panel/health")) {
      sendJson(res, 200, { ok: true, service: "zcode-panel" });
      return;
    }

    if (path !== "/api/control") {
      sendJson(res, 404, { ok: false, error: `not_found: ${method} ${path}` });
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    // Auth before anything else: an unauthenticated request must not reach the
    // dispatcher (which can stop the proxy or clear the stored credential).
    if (!tokenMatches(extractToken(req), token)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { ok: false, error: "request_too_large" });
      return;
    }

    let cmd: ControlCommand;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null || typeof (parsed as { cmd?: unknown }).cmd !== "string") {
        sendJson(res, 400, { ok: false, error: "invalid_command" });
        return;
      }
      cmd = parsed as ControlCommand;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_json" });
      return;
    }

    try {
      // Same envelope semantics as the control listener: a failed command is a
      // 200 with `{ok:false,error}`, so the page can render the reason verbatim.
      const result = await opts.handleControl(cmd);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `internal_error: ${(err as Error).message}` });
    }
  };
}

/**
 * Start the panel on `opts.hostname` (loopback by default). Throws when the
 * token is missing (silently starting an unauthenticated panel is the one
 * outcome this module refuses to allow) or when the port cannot be bound.
 * There is nothing else to roll back on failure: the panel owns the only
 * listener it opens.
 */
export async function startPanelServer(opts: PanelOptions): Promise<PanelServer> {
  const token = (opts.token ?? "").trim();
  if (!token) throw new Error(`panel token required (set ${PANEL_TOKEN_ENV})`);
  const hostname = opts.hostname ?? DEFAULT_PANEL_HOST;
  const handler = createPanelHandler({ ...opts, token });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(opts.port, hostname, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    hostname,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
