/**
 * Localhost-only HTTP control listener for the Android app's Kotlin shell.
 *
 * The Kotlin foreground service starts the Node.js proxy server and a small
 * control listener on a separate port (passed via env `ZCODE_CONTROL_PORT`).
 * The proxy listener serves `/v1/*`, `/webui`, `/health`; the control listener
 * serves only `POST /control` and is bound to `127.0.0.1` so other devices on
 * the LAN cannot reach it. Two layers enforce loopback-only access:
 *
 * 1. `server.listen(port, "127.0.0.1", ...)` — never binds to `0.0.0.0`.
 * 2. Per-request `req.socket.remoteAddress` check — defends against a future
 *    bind regression where the listener accidentally widens.
 *
 * The listener exposes a JSON command protocol so Kotlin can drive OAuth
 * (via embedded WebView), start/stop the proxy server, update runtime config
 * (provider/plan), poll logs, and shut down the Node process.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ProviderId } from "../provider/types.js";
import type { Credential } from "../auth/types.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { saveCredential, clearCredential, loadCredential } from "../auth/store.js";

/** Supported plan tiers. Mirrors `ProxyConfig.plan`. */
export type PlanTier = "coding-plan" | "start-plan";

/** The control protocol: request shape for `POST /control`. */
export type ControlCommand =
  | { cmd: "status" }
  | { cmd: "startOAuth"; provider: ProviderId }
  | { cmd: "deliverOAuthCode"; provider: ProviderId; code: string; state: string }
  | { cmd: "logout" }
  | { cmd: "setConfig"; provider?: ProviderId; plan?: PlanTier }
  | { cmd: "startProxy" }
  | { cmd: "stopProxy" }
  | { cmd: "getLogs"; since?: number }
  | { cmd: "shutdown" };

/** Successful response envelope. */
export type ControlOk =
  | { ok: true; state: "running"; provider: ProviderId; plan: PlanTier; proxyPort: number; loggedIn: boolean }
  | { ok: true; event: "oauthUrl"; authorizeUrl: string; callbackPort: number }
  | { ok: true; event: "loginOk"; provider: ProviderId }
  | { ok: true; event: "loggedOut" }
  | { ok: true; event: "configUpdated"; provider: ProviderId; plan: PlanTier }
  | { ok: true; event: "proxyStarted"; port: number }
  | { ok: true; event: "proxyStopped" }
  | { ok: true; event: "logs"; nextSince: number; lines: string[] }
  | { ok: true; event: "shuttingDown" };

/** Failure response envelope. */
export interface ControlError {
  ok: false;
  error: string;
}

export type ControlResponse = ControlOk | ControlError;

/** Result type returned by lifecycle hooks (start/stop proxy). */
export type LifecycleResult =
  | { ok: true; port: number }
  | { ok: false; error: string };

/** Result type returned by `setConfig` hook. */
export type ConfigUpdateResult =
  | { ok: true; provider: ProviderId; plan: PlanTier }
  | { ok: false; error: string };

/** Internal mutable state shared with the proxy entry. */
export interface ControlState {
  provider: ProviderId;
  plan: PlanTier;
  /** Currently-bound proxy server port. 0 when proxy is stopped. */
  proxyPort: number;
  /** Active OAuth client while a flow is in flight; nulled on completion. */
  activeOauth?: {
    client: ZaiOAuthClient | BigmodelOAuthClient;
    callbackUrl: string;
    state: string;
  };
}

interface StartControlOpts {
  port: number;
  state: ControlState;
  /** Start the proxy server. Returns the bound port on success. */
  onStartProxy?: () => Promise<LifecycleResult>;
  /** Stop the proxy server. */
  onStopProxy?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Update runtime config (provider and/or plan). */
  onSetConfig?: (changes: { provider?: ProviderId; plan?: PlanTier }) => Promise<ConfigUpdateResult>;
  /** Hook for graceful shutdown (called by the `shutdown` command). */
  onShutdown?: () => Promise<void> | void;
  /** Log buffer polled by `getLogs`. If omitted, an internal one is used. */
  logBuffer?: LogBuffer;
}

/** Bounded ring buffer for runtime log lines with monotonic sequence numbers. */
export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly capacity: number;
  private nextSeq = 0;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  push(line: string): void {
    this.lines.push(line);
    this.nextSeq++;
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }

  /**
   * Returns lines whose logical sequence number is `>= since`, plus the
   * next-since cursor (use as the next `since` value for incremental polling).
   */
  since(since: number): { nextSince: number; lines: string[] } {
    const baseSeq = Math.max(0, this.nextSeq - this.lines.length);
    const wantStart = Math.max(since, baseSeq);
    const offset = wantStart - baseSeq;
    if (offset >= this.lines.length) {
      return { nextSince: this.nextSeq, lines: [] };
    }
    return { nextSince: this.nextSeq, lines: this.lines.slice(offset) };
  }

  /** Returns all lines currently in the buffer. */
  snapshot(): readonly string[] {
    return this.lines;
  }

  /** Monotonic cursor; safe to expose externally. */
  get cursor(): number {
    return this.nextSeq;
  }
}

/** Start the control listener bound to 127.0.0.1. Resolves once listening. */
export function startControlListener(opts: StartControlOpts): Promise<{ close(): Promise<void> }> {
  const logBuffer = opts.logBuffer ?? new LogBuffer();
  const server: Server = createServer(async (req, res) => {
    try {
      const result = await handleControlRequest(req, opts.state, {
        onStartProxy: opts.onStartProxy,
        onStopProxy: opts.onStopProxy,
        onSetConfig: opts.onSetConfig,
        onShutdown: opts.onShutdown,
        logBuffer,
      });
      writeJson(res, result.status, result.body);
    } catch (err) {
      writeJson(res, 500, { ok: false, error: `internal_error: ${(err as Error).message}` });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve({
      close: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}

export interface ControlHandlerResult {
  status: number;
  body: ControlResponse;
}

/** Context passed to `handleControlRequest` for hook wiring + log access. */
export interface HandlerContext {
  onStartProxy?: () => Promise<LifecycleResult>;
  onStopProxy?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSetConfig?: (changes: { provider?: ProviderId; plan?: PlanTier }) => Promise<ConfigUpdateResult>;
  onShutdown?: () => Promise<void> | void;
  logBuffer: LogBuffer;
}

export function handleControlRequestForTest(
  req: IncomingMessage,
  state: ControlState,
  onShutdown?: () => Promise<void> | void,
): Promise<ControlHandlerResult> {
  // Backwards-compatible shape: only `onShutdown` is wired.
  const ctx: HandlerContext = { onShutdown, logBuffer: new LogBuffer() };
  return handleControlRequest(req, state, ctx);
}

/**
 * Test entry that allows wiring all lifecycle hooks. Prefer this in new tests
 * for startProxy/stopProxy/setConfig/getLogs coverage.
 */
export function handleControlRequestWithHooksForTest(
  req: IncomingMessage,
  state: ControlState,
  ctx: HandlerContext,
): Promise<ControlHandlerResult> {
  return handleControlRequest(req, state, ctx);
}

async function handleControlRequest(
  req: IncomingMessage,
  state: ControlState,
  ctx: HandlerContext,
): Promise<ControlHandlerResult> {
  if (!isLoopback(req.socket.remoteAddress)) {
    return { status: 403, body: { ok: false, error: "forbidden: non-loopback remote address" } };
  }

  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "POST" || parsed.pathname !== "/control") {
    return { status: 404, body: { ok: false, error: `not_found: ${req.method} ${parsed.pathname}` } };
  }

  const body = await readBody(req);
  let cmd: ControlCommand;
  try {
    cmd = JSON.parse(body) as ControlCommand;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  const result = await dispatch(cmd, state, ctx);
  return { status: 200, body: result };
}

async function dispatch(
  cmd: ControlCommand,
  state: ControlState,
  ctx: HandlerContext,
): Promise<ControlResponse> {
  switch (cmd.cmd) {
    case "status": {
      const cred = await loadCredential().catch(() => null);
      return {
        ok: true,
        state: "running",
        provider: state.provider,
        plan: state.plan,
        proxyPort: state.proxyPort,
        loggedIn: cred != null,
      };
    }

    case "startOAuth": {
      const client = cmd.provider === "bigmodel" ? new BigmodelOAuthClient() : new ZaiOAuthClient();
      const started = await client.start();
      const callbackUrlObj = new URL(started.callbackUrl);
      const callbackPort = callbackUrlObj.port ? Number(callbackUrlObj.port) : 80;
      state.activeOauth = {
        client,
        callbackUrl: started.callbackUrl,
        state: started.state,
      };
      client.waitForCallback().then(async (code) => {
        try {
          const { accessToken, userId, jwt } = await client.exchangeCode(code, started.callbackUrl, started.state);
          const resolver = new KeyResolver();
          const cred: Credential = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
          if (jwt) cred.jwt = jwt;
          await saveCredential(cred);
          console.log(`OAuth completed for ${cmd.provider} via browser callback`);
        } catch (err) {
          console.error(`OAuth auto-complete failed: ${(err as Error).message}`);
        } finally {
          await client.close().catch(() => {});
          if (state.activeOauth?.state === started.state) state.activeOauth = undefined;
        }
      }).catch(() => {});
      return {
        ok: true,
        event: "oauthUrl",
        authorizeUrl: started.authorizeUrl,
        callbackPort,
      };
    }

    case "deliverOAuthCode": {
      const active = state.activeOauth;
      if (!active || active.state !== cmd.state) {
        return { ok: false, error: "no_matching_oauth_flow" };
      }
      try {
        const { accessToken, userId, jwt } = await active.client.exchangeCode(
          cmd.code,
          active.callbackUrl,
          cmd.state,
        );
        const resolver = new KeyResolver();
        const cred: Credential = await resolver.resolveCodingPlanCredential(accessToken, cmd.provider, userId);
        if (jwt) cred.jwt = jwt;
        await saveCredential(cred);
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: true, event: "loginOk", provider: cmd.provider };
      } catch (err) {
        state.activeOauth = undefined;
        await active.client.close().catch(() => {});
        return { ok: false, error: `oauth_exchange_failed: ${(err as Error).message}` };
      }
    }

    case "logout": {
      await clearCredential();
      return { ok: true, event: "loggedOut" };
    }

    case "setConfig": {
      if (!ctx.onSetConfig) return { ok: false, error: "config_update_unavailable" };
      const result = await ctx.onSetConfig({ provider: cmd.provider, plan: cmd.plan });
      if (!result.ok) return result;
      state.provider = result.provider;
      state.plan = result.plan;
      return { ok: true, event: "configUpdated", provider: result.provider, plan: result.plan };
    }

    case "startProxy": {
      if (!ctx.onStartProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result = await ctx.onStartProxy();
      if (!result.ok) return result;
      state.proxyPort = result.port;
      return { ok: true, event: "proxyStarted", port: result.port };
    }

    case "stopProxy": {
      if (!ctx.onStopProxy) return { ok: false, error: "proxy_lifecycle_unavailable" };
      const result = await ctx.onStopProxy();
      if (!result.ok) return result;
      state.proxyPort = 0;
      return { ok: true, event: "proxyStopped" };
    }

    case "getLogs": {
      const since = typeof cmd.since === "number" ? cmd.since : 0;
      const { nextSince, lines } = ctx.logBuffer.since(since);
      return { ok: true, event: "logs", nextSince, lines: [...lines] };
    }

    case "shutdown": {
      if (ctx.onShutdown) await ctx.onShutdown();
      return { ok: true, event: "shuttingDown" };
    }

    default:
      return { ok: false, error: `unknown_cmd: ${(cmd as { cmd: string }).cmd}` };
  }
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
