/**
 * OAuth flow handlers for Z.AI and Bigmodel.
 *
 * The two providers use **different flows** (verified against the ZCode 3.10
 * desktop bundle `loginZCodeCli` / `loginBigmodelCodingPlan`, and live-probed
 * 2026-08-29):
 *
 * - Z.AI: **server-mediated CLI login**. The client POSTs `{provider:"zai"}` to
 *   `zcode.z.ai/api/v1/oauth/cli/init` and gets back a server-generated
 *   authorize URL whose redirect_uri is zcode.z.ai's OWN callback
 *   (`/api/v1/oauth/cli/callback/zai`) — NOT localhost. After the user
 *   authorizes in the browser, the client polls `/oauth/cli/poll/{flow_id}`
 *   until the server reports `ready` with the tokens. No local callback server
 *   exists for Z.AI. Building the old 3.1.x-style direct chat.z.ai authorize
 *   URL with a localhost redirect_uri is rejected upstream with
 *   `{"detail":"Redirect URI not registered for this client"}`.
 * - Bigmodel: **classic auth-code flow** — local callback server on 127.0.0.1,
 *   authorize at `bigmodel.cn/login?appId&redirect&state`, then exchange the
 *   returned code at the shared zcode.z.ai token endpoint.
 *
 * @see _reverse/NOTEPAD.md "Method 1: OAuth Flow"
 */
import type { ProviderId } from "../provider/types.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from bundle)
// ---------------------------------------------------------------------------

/** zcode.z.ai API base (bundle `A3o`; cli-login + token endpoints hang off it). */
const ZCODE_API_BASE = "https://zcode.z.ai/api/v1";
/** Shared token-exchange endpoint (bigmodel auth-code flow). Bundle: `tokenUrl`. */
const ZCODE_TOKEN_ENDPOINT = `${ZCODE_API_BASE}/oauth/token`;
/** Default Bigmodel authorize host (bundle `BIGMODEL_OAUTH_AUTHORIZE_URL`). */
const BIGMODEL_HOST = "https://bigmodel.cn";
/** Default Bigmodel app id (bundle `BIGMODEL_OAUTH_APP_ID`). */
const BIGMODEL_APP_ID = "zcode";

/** Overall login timeout shared by both flows (bundle `tln`). */
const LOGIN_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface OAuthResult {
  accessToken: string;
  provider: ProviderId;
  /** Upstream user identifier, when the OAuth response included one. Passed through to `metadata.user_id` on Anthropic-format requests. */
  userId?: string;
  /** ZCode plan JWT for start-plan (zcode.z.ai). The token-exchange response includes this alongside the provider access_token. */
  jwt?: string;
}

export type FetchFn = typeof fetch;

/** Flow handle returned by `start()`. */
export interface OAuthFlowStart {
  authorizeUrl: string;
  /** Local callback URL when the flow uses one (bigmodel); `""` otherwise (zai cli flow). */
  callbackUrl: string;
  /** CSRF state (auth-code) / server flow_id (zai cli flow) — opaque bookkeeping. */
  state: string;
}

/** Credentials produced by a completed flow, pre-`KeyResolver`. */
export interface OAuthFlowTokens {
  accessToken: string;
  userId?: string;
  jwt?: string;
}

/** Shape of the zcode.z.ai `{code, data, msg}` envelope (token + cli-login endpoints). */
interface ZcodeEnvelope {
  code?: number;
  data?: unknown;
  msg?: string;
}

// ---------------------------------------------------------------------------
// Shared flow base
// ---------------------------------------------------------------------------

/**
 * Common lifecycle for both login flows: `start()` produces the authorize URL,
 * `complete()` blocks until the flow finishes (callback redirect or server
 * poll), `authorize()` chains them for the CLI. `src/android/control.ts`
 * drives `start()` + `complete()` so the authorize URL can be surfaced to the
 * app while completion continues in the background.
 */
export abstract class OAuthFlowClient {
  constructor(
    readonly provider: ProviderId,
    protected readonly fetchImpl: FetchFn,
  ) {}

  abstract start(): Promise<OAuthFlowStart>;
  abstract complete(started: OAuthFlowStart, timeoutMs?: number): Promise<OAuthFlowTokens>;
  abstract close(): Promise<void>;

  /** Run the full flow end-to-end: surface authorize URL, wait, close. */
  async authorize(
    onAuthorizeUrl?: (url: string) => void,
    timeoutMs: number = LOGIN_TIMEOUT_MS,
  ): Promise<OAuthResult> {
    const started = await this.start();
    onAuthorizeUrl?.(started.authorizeUrl);
    try {
      const tokens = await this.complete(started, timeoutMs);
      return { accessToken: tokens.accessToken, provider: this.provider, userId: tokens.userId, jwt: tokens.jwt };
    } finally {
      await this.close();
    }
  }
}

/**
 * POST/GET a zcode.z.ai endpoint and unwrap the `{code, data, msg}` envelope
 * (mirrors the bundle's `H2r`: numeric code required, non-2xx or `code !== 0`
 * surfaces the server `msg`).
 */
async function requestZcodeEnvelope(
  fetchImpl: FetchFn,
  url: string,
  init: RequestInit,
  label: string,
): Promise<unknown> {
  const resp = await fetchImpl(url, init);
  const raw = safeJsonParse(await resp.text()) as ZcodeEnvelope | null;
  if (!raw || typeof raw.code !== "number") {
    throw new Error(`${label}: invalid response envelope (status=${resp.status})`);
  }
  if (!resp.ok || raw.code !== 0) {
    throw new Error(`${label} failed: status=${resp.status} msg=${raw.msg ?? "(none)"}`);
  }
  return raw.data;
}

// ---------------------------------------------------------------------------
// Z.AI — server-mediated CLI login (init + poll, no local callback)
// ---------------------------------------------------------------------------

/** `data` of a successful `/oauth/cli/init` call (bundle `D3o`). */
interface ZaiCliInitData {
  flow_id: string;
  /** Server-issued poll token; informational — poll re-sends the client Bearer. */
  poll_token: string;
  authorize_url: string;
  /** Unix seconds. */
  expires_at: number;
  poll_interval_sec: number;
}

/** `data` of a `/oauth/cli/poll/{flow_id}` call: pending/failed, or ready (bundle `N3o`/`L3o`). */
interface ZaiCliPollData {
  status: string;
  token?: string;
  user?: { user_id?: unknown };
  zai?: { access_token?: unknown };
}

/**
 * Z.AI login client, mirroring ZCode 3.10 `loginZCodeCli`:
 *
 *   1. Generate a client poll token (32 random bytes, hex) — sent as
 *      `Authorization: Bearer` on BOTH init and poll.
 *   2. `POST {ZCODE_API_BASE}/oauth/cli/init` body `{provider:"zai"}` →
 *      `{flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}`.
 *   3. Open the server-provided `authorize_url` (its redirect_uri is
 *      zcode.z.ai's own `/oauth/cli/callback/zai` — the browser never comes
 *      back to localhost).
 *   4. `GET {ZCODE_API_BASE}/oauth/cli/poll/{flow_id}` every
 *      `poll_interval_sec` until `status:"ready"` → `{token, user, zai}` —
 *      or `"failed"`, or the `expires_at`/timeout deadline passes.
 */
export class ZaiOAuthClient extends OAuthFlowClient {
  private flow: ZaiCliInitData | null = null;
  private pollToken = "";

  constructor(
    fetchImpl: FetchFn = fetch,
    /** Injectable pause between polls (tests pass a no-op). */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    super("zai", fetchImpl);
  }

  start(): Promise<OAuthFlowStart> {
    this.flow = null;
    this.pollToken = randomBytes(32).toString("hex");
    return (async () => {
      const data = (await requestZcodeEnvelope(
        this.fetchImpl,
        `${ZCODE_API_BASE}/oauth/cli/init`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${this.pollToken}`, "content-type": "application/json" },
          body: JSON.stringify({ provider: this.provider }),
        },
        "Z.AI login init",
      )) as Partial<ZaiCliInitData> | null;
      if (
        !data ||
        typeof data.flow_id !== "string" ||
        typeof data.authorize_url !== "string" ||
        typeof data.expires_at !== "number" ||
        typeof data.poll_interval_sec !== "number"
      ) {
        throw new Error("Z.AI login init: invalid response data");
      }
      this.flow = data as ZaiCliInitData;
      return { authorizeUrl: this.flow.authorize_url, callbackUrl: "", state: this.flow.flow_id };
    })();
  }

  async complete(_started: OAuthFlowStart, timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<OAuthFlowTokens> {
    const flow = this.flow;
    if (!flow) throw new Error("Z.AI login not started");
    const deadlineMs = Math.min(Date.now() + timeoutMs, flow.expires_at * 1000);
    const intervalMs = Math.max(1_000, flow.poll_interval_sec * 1000);

    for (;;) {
      if (Date.now() >= deadlineMs) {
        throw new Error("Authorization timed out. Please retry login.");
      }
      const data = (await requestZcodeEnvelope(
        this.fetchImpl,
        `${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(flow.flow_id)}`,
        { method: "GET", headers: { authorization: `Bearer ${this.pollToken}` } },
        "Z.AI login poll",
      )) as Partial<ZaiCliPollData> | null;

      if (data?.status === "ready") {
        const accessToken = typeof data.zai?.access_token === "string" ? data.zai.access_token.trim() : "";
        if (!accessToken) {
          throw new Error("Z.AI login poll: response missing data.zai.access_token");
        }
        return {
          accessToken,
          jwt: typeof data.token === "string" ? data.token.trim() : undefined,
          userId: typeof data.user?.user_id === "string" ? data.user.user_id : undefined,
        };
      }
      if (data?.status === "failed") {
        throw new Error("Authorization failed. Please retry login.");
      }
      if (data?.status !== "pending") {
        throw new Error(`Z.AI login poll: unexpected status ${String(data?.status ?? "(none)")}`);
      }
      await this.sleep(Math.min(intervalMs, Math.max(0, deadlineMs - Date.now())));
    }
  }

  async close(): Promise<void> {
    this.flow = null;
  }
}

// ---------------------------------------------------------------------------
// Bigmodel — classic auth-code flow with a localhost callback server
// ---------------------------------------------------------------------------

/**
 * Per-provider auth-code configuration (Bigmodel only since Z.AI moved to the
 * cli login flow).
 */
interface AuthCodeConfig {
  readonly provider: ProviderId;
  /** Base authorize URL (`?appId=&redirect=&state=` appended). */
  readonly authorizeUrl: string;
  readonly appId: string;
  /** Shared zcode.z.ai token-exchange endpoint. */
  readonly tokenUrl: string;
  /** Path served by the localhost callback server. */
  readonly callbackPath: string;
  /** Key under `data` holding the provider access token: `data[field].access_token`. */
  readonly accessTokenField: string;
}

/** Shape of the zcode.z.ai token-exchange response (`{code, data, msg}`). */
interface TokenExchangeResponse {
  code?: number;
  data?: {
    token?: string;
    user?: { user_id?: string };
  } & Record<string, unknown>;
  msg?: string;
}

/**
 * Auth-code OAuth client: localhost callback server + token exchange.
 *
 * Flow (mirrors the ZCode desktop `loginBigmodelCodingPlan`):
 *   1. Start localhost HTTP server on a random port
 *   2. Build authorize URL: `{authorizeUrl}?appId={appId}&redirect={localhost}&state={state}`
 *   3. User opens the URL, authorizes on the provider's site
 *   4. Provider redirects to localhost callback with `?authCode=...&state=...`
 *   5. POST `{tokenUrl}` body `{provider, code, redirect_uri, state}`
 *   6. zcode.z.ai exchanges (holding the app secret server-side) and returns
 *      `{code:0, data:{token:<jwt>, <provider>:{access_token}, user:{user_id}}}`
 */
export class AuthCodeOAuthClient extends OAuthFlowClient {
  private server: Server | null = null;
  private callbackResult: { code: string; error: string | null } | null = null;
  private callbackWaiters: Array<(result: { code: string; error: string | null }) => void> = [];

  constructor(
    config: AuthCodeConfig,
    fetchImpl: FetchFn = fetch,
  ) {
    super(config.provider, fetchImpl);
    this.config = config;
  }

  private readonly config: AuthCodeConfig;

  /** Build the provider authorize URL with the localhost redirect + state. */
  protected buildAuthorizeUrl(callbackUrl: string, state: string): string {
    const params = new URLSearchParams({
      appId: this.config.appId,
      redirect: callbackUrl,
      state,
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Start the localhost callback server and return the authorize URL.
   * Call `waitForCallback()` (or `authorize()`) afterwards, then `close()`.
   *
   * The bind port is `0` (OS-assigned random) unless the env var
   * `ZCODE_OAUTH_CALLBACK_PORT` is set, in which case that exact port is used.
   * The Android entry sets the env var so the Custom Tabs redirect URL is
   * predictable across launches.
   */
  start(): Promise<OAuthFlowStart> {
    const state = randomBytes(32).toString("hex");
    const requestedPort = Number(process.env.ZCODE_OAUTH_CALLBACK_PORT ?? 0) || 0;

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleCallback(req, res, state);
      });

      this.server.on("error", (err) => {
        this.server = null;
        reject(err);
      });
      this.server.listen(requestedPort, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (!addr || typeof addr !== "object") {
          reject(new Error("Failed to bind localhost callback server"));
          return;
        }
        const callbackUrl = `http://127.0.0.1:${addr.port}${this.config.callbackPath}`;
        const authorizeUrl = this.buildAuthorizeUrl(callbackUrl, state);
        resolve({ authorizeUrl, callbackUrl, state });
      });
    });
  }

  private handleCallback(req: IncomingMessage, res: ServerResponse, expectedState: string): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== this.config.callbackPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";

    if (state !== expectedState || !code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Authorization failed: state mismatch or missing code.");
      if (!this.callbackResult) {
        this.callbackResult = { code: "", error: "OAuth callback state mismatch or missing code." };
        this.callbackWaiters.forEach((fn) => fn(this.callbackResult!));
      }
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Authorization successful! You may close this window and return to the CLI.");

    if (!this.callbackResult) {
      this.callbackResult = { code, error: null };
      this.callbackWaiters.forEach((fn) => fn(this.callbackResult!));
    }
  }

  /** Wait for the OAuth callback redirect. Resolves with the auth code. */
  waitForCallback(timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<string> {
    if (this.callbackResult?.code) {
      return Promise.resolve(this.callbackResult.code);
    }
    if (this.callbackResult?.error) {
      return Promise.reject(new Error(this.callbackResult.error));
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Authorization timed out. Please retry login."));
      }, timeoutMs);

      this.callbackWaiters.push((result) => {
        clearTimeout(timer);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result.code);
        }
      });
    });
  }

  /**
   * Exchange the auth code at the shared zcode.z.ai token endpoint.
   * The ZCode server holds the app secret and performs the real provider exchange.
   * Returns `{ accessToken, userId, jwt }`.
   */
  async exchangeCode(
    authCode: string,
    redirectUri: string,
    state: string,
  ): Promise<OAuthFlowTokens> {
    const resp = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: this.config.provider,
        code: authCode,
        redirect_uri: redirectUri,
        state,
      }),
    });

    const raw = safeJsonParse(await resp.text()) as TokenExchangeResponse | null;

    if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
      const label = this.config.provider;
      throw new Error(
        `${label} token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`,
      );
    }

    const providerToken = raw?.data?.[this.config.accessTokenField] as
      | { access_token?: string }
      | undefined;
    const accessToken = providerToken?.access_token?.trim() ?? "";

    if (!accessToken) {
      throw new Error(`${this.config.provider} token response missing data.${this.config.accessTokenField}.access_token`);
    }

    const userId = raw?.data?.user?.user_id;
    const jwt = raw?.data?.token?.trim() ?? undefined;
    return { accessToken, userId: typeof userId === "string" ? userId : undefined, jwt };
  }

  /** Wait for the browser callback, then exchange the code. */
  async complete(started: OAuthFlowStart, timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<OAuthFlowTokens> {
    const code = await this.waitForCallback(timeoutMs);
    return this.exchangeCode(code, started.callbackUrl, started.state);
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = null;
      // Drop idle keep-alive connections so the port is released immediately
      // (plain close() would wait for them to time out).
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Provider clients
// ---------------------------------------------------------------------------

/**
 * Bigmodel auth-code config.
 * Bundle `ed`: authorizeUrl `bigmodel.cn/login`, appId `zcode`,
 * token field `data.bigmodel.access_token`.
 */
const BIGMODEL_AUTH_CODE_CONFIG: AuthCodeConfig = {
  provider: "bigmodel",
  authorizeUrl: `${BIGMODEL_HOST}/login`,
  appId: BIGMODEL_APP_ID,
  tokenUrl: ZCODE_TOKEN_ENDPOINT,
  callbackPath: "/oauth/callback/bigmodel",
  accessTokenField: "bigmodel",
};

/**
 * Bigmodel OAuth client (auth-code flow via bigmodel.cn + zcode.z.ai token
 * exchange). `host`/`appId` are overridable to mirror the bundle's env vars
 * (`BIGMODEL_OAUTH_AUTHORIZE_URL`, `BIGMODEL_OAUTH_APP_ID`).
 */
export class BigmodelOAuthClient extends AuthCodeOAuthClient {
  constructor(
    fetchImpl: FetchFn = fetch,
    host: string = BIGMODEL_HOST,
    appId: string = BIGMODEL_APP_ID,
  ) {
    super(
      { ...BIGMODEL_AUTH_CODE_CONFIG, authorizeUrl: `${host}/login`, appId },
      fetchImpl,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
