/**
 * OAuth flow handlers for Z.AI and Bigmodel.
 *
 * Verified against the ZCode 3.12.3 desktop bundle (`_reverse/NOTEPAD.md`
 * "OAuth 流程"; previous live-probe of the 3.10 flow):
 *
 * - Both providers default to the **server-mediated CLI login** (bundle
 *   `startOAuthWithPolling`): POST `{provider}` to
 *   `zcode.z.ai/api/v1/oauth/cli/init`, open the returned `authorize_url`
 *   (with the client-appended `/app/oauth/login` interstitial param —
 *   `redirect_uri` for zai, `redirect` for bigmodel), then poll
 *   `/oauth/cli/poll/{flow_id}` until the server reports `ready` with the
 *   tokens. No local callback server exists on this path. Building a direct
 *   chat.z.ai/bigmodel authorize URL with a localhost redirect_uri is
 *   rejected upstream (`Redirect URI not registered for this client`).
 * - Poll error semantics mirror the bundle: 4xx (except 408/429), envelope
 *   `code !== 0`, or an unknown status are fatal; 5xx / network errors /
 *   malformed 200 bodies are retried as if `pending`.
 * - Bigmodel keeps a **classic auth-code flow** (`BigmodelOAuthClient`) for
 *   the headless `--paste` login only — the desktop no longer uses it as the
 *   primary path but the protocol (authorize at `bigmodel.cn/login`, exchange
 *   at the shared zcode.z.ai token endpoint) is unchanged.
 *
 * @see _reverse/NOTEPAD.md "4. OAuth 流程"
 */
import type { ProviderId } from "../provider/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from bundle)
// ---------------------------------------------------------------------------

/** zcode.z.ai API base (bundle `A3o`; cli-login + token endpoints hang off it). */
const ZCODE_API_BASE_ORIGIN = "https://zcode.z.ai";
const ZCODE_API_BASE = `${ZCODE_API_BASE_ORIGIN}/api/v1`;
/** Shared token-exchange endpoint (bigmodel auth-code flow). Bundle: `tokenUrl`. */
const ZCODE_TOKEN_ENDPOINT = `${ZCODE_API_BASE}/oauth/token`;
/** Default Bigmodel authorize host (bundle `BIGMODEL_OAUTH_AUTHORIZE_URL`). */
const BIGMODEL_HOST = "https://bigmodel.cn";
/** Default Bigmodel app id (bundle `BIGMODEL_OAUTH_APP_ID`). */
const BIGMODEL_APP_ID = "zcode";

/** Overall login timeout shared by both flows (bundle `tln`). */
export const LOGIN_TIMEOUT_MS = 300_000;

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
  /** Local callback URL when the flow uses one (bigmodel paste login); `""` otherwise (cli poll flow). */
  callbackUrl: string;
  /** CSRF state (auth-code) / server flow_id (cli poll flow) — opaque bookkeeping. */
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
// Server-mediated CLI login (init + poll, no local callback) — both providers
// ---------------------------------------------------------------------------

/** `data` of a successful `/oauth/cli/init` call (bundle `startOAuthWithPolling`). */
interface CliInitData {
  flow_id: string;
  /** Server-issued poll token; informational — poll re-sends the client Bearer. */
  poll_token: string;
  authorize_url: string;
  /** Unix seconds. */
  expires_at: number;
  poll_interval_sec: number;
}

/** `data` of a `/oauth/cli/poll/{flow_id}` call: pending/failed, or ready. */
interface CliPollData {
  status: string;
  token?: string;
  user?: { user_id?: unknown };
  zai?: { access_token?: unknown };
  bigmodel?: { access_token?: unknown };
}

/**
 * The interstitial the 3.12.3 client appends to the server-provided
 * authorize_url (bundle `Ed` = buildDesktopOAuthRedirectUriFromEnv): a
 * zcode.z.ai page that records the authorization server-side (so the poll
 * flips to `ready`) before bouncing the browser to `zcode://oauth/callback`.
 * Param name differs per provider: `redirect_uri` (zai) / `redirect` (bigmodel).
 */
function buildDesktopOAuthRedirectParam(appVersion: string): string {
  const url = new URL("/app/oauth/login", ZCODE_API_BASE_ORIGIN);
  url.searchParams.set("redirect", "zcode://oauth/callback");
  url.searchParams.set("app_version", appVersion);
  return url.toString();
}

/**
 * Server-mediated CLI login, mirroring ZCode 3.12.3 `startOAuthWithPolling`
 * (used for BOTH zai and bigmodel):
 *
 *   1. Generate a client poll token (32 random bytes, hex) — sent as
 *      `Authorization: Bearer` on BOTH init and poll.
 *   2. `POST {ZCODE_API_BASE}/oauth/cli/init` body `{provider}` →
 *      `{flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}`.
 *   3. Open the server-provided `authorize_url` with the interstitial param
 *      appended — the browser never comes back to localhost; the flow
 *      completes server-side.
 *   4. `GET {ZCODE_API_BASE}/oauth/cli/poll/{flow_id}` every
 *      `poll_interval_sec` until `status:"ready"` →
 *      `{token, user, zai|bigmodel:{access_token}}` — or `"failed"`, a fatal
 *      4xx, or the `expires_at`/timeout deadline.
 */
export class PollOAuthClient extends OAuthFlowClient {
  private flow: CliInitData | null = null;
  private pollToken = "";

  constructor(
    provider: ProviderId,
    fetchImpl: FetchFn = fetch,
    /** Injectable pause between polls (tests pass a no-op). */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly appVersion: string = DEFAULT_APP_VERSION,
  ) {
    super(provider, fetchImpl);
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
        `${this.provider} login init`,
      )) as Partial<CliInitData> | null;
      if (
        !data ||
        typeof data.flow_id !== "string" ||
        typeof data.authorize_url !== "string" ||
        typeof data.expires_at !== "number" ||
        typeof data.poll_interval_sec !== "number"
      ) {
        throw new Error(`${this.provider} login init: invalid response data`);
      }
      this.flow = data as CliInitData;
      return { authorizeUrl: this.applyInterstitial(data.authorize_url), callbackUrl: "", state: data.flow_id };
    })();
  }

  /** Append the desktop interstitial param (bundle: `redirect_uri` for zai, `redirect` for bigmodel). */
  private applyInterstitial(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    url.searchParams.set(
      this.provider === "zai" ? "redirect_uri" : "redirect",
      buildDesktopOAuthRedirectParam(this.appVersion),
    );
    return url.toString();
  }

  async complete(_started: OAuthFlowStart, timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<OAuthFlowTokens> {
    const flow = this.flow;
    if (!flow) throw new Error(`${this.provider} login not started`);
    const deadlineMs = Math.min(Date.now() + timeoutMs, flow.expires_at * 1000);
    const intervalMs = Math.max(1_000, flow.poll_interval_sec * 1000);

    for (;;) {
      if (Date.now() >= deadlineMs) {
        throw new Error("Authorization timed out. Please retry login.");
      }
      const outcome = await this.pollOnce(flow.flow_id);
      if (outcome.retry) {
        await this.sleep(Math.min(intervalMs, Math.max(0, deadlineMs - Date.now())));
        continue;
      }
      const data = outcome.data;

      if (data?.status === "ready") {
        const providerPayload = data[this.provider] as { access_token?: unknown } | undefined;
        const accessToken =
          typeof providerPayload?.access_token === "string" ? providerPayload.access_token.trim() : "";
        if (!accessToken) {
          throw new Error(`${this.provider} login poll: response missing data.${this.provider}.access_token`);
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
        throw new Error(`${this.provider} login poll: unexpected status ${String(data?.status ?? "(none)")}`);
      }
      await this.sleep(Math.min(intervalMs, Math.max(0, deadlineMs - Date.now())));
    }
  }

  /**
   * One poll round with the bundle's error semantics: 4xx (except 408/429),
   * envelope `code !== 0`, or an unknown status are fatal; network errors,
   * 5xx/408/429, and a malformed 200 body are retried as if `pending`.
   */
  private async pollOnce(flowId: string): Promise<{ retry: true } | { retry: false; data: Partial<CliPollData> | null }> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${ZCODE_API_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.pollToken}` },
      });
    } catch {
      return { retry: true };
    }
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
      throw new Error(`${this.provider} login poll failed: status=${resp.status}`);
    }
    if (!resp.ok) {
      return { retry: true };
    }
    const raw = safeJsonParse(await resp.text()) as ZcodeEnvelope | null;
    if (!raw || typeof raw.code !== "number") {
      return { retry: true };
    }
    if (raw.code !== 0) {
      throw new Error(`${this.provider} login poll failed: code=${raw.code} msg=${raw.msg ?? "(none)"}`);
    }
    return { retry: false, data: raw.data as Partial<CliPollData> | null };
  }

  async close(): Promise<void> {
    this.flow = null;
  }
}

/** Z.AI poll-flow login client (name kept for existing call sites). */
export class ZaiOAuthClient extends PollOAuthClient {
  constructor(
    fetchImpl: FetchFn = fetch,
    sleep: (ms: number) => Promise<void> = defaultSleep,
    appVersion: string = DEFAULT_APP_VERSION,
  ) {
    super("zai", fetchImpl, sleep, appVersion);
  }
}

/** Bigmodel poll-flow login client — the 3.12.3 desktop default for bigmodel. */
export class BigmodelPollOAuthClient extends PollOAuthClient {
  constructor(
    fetchImpl: FetchFn = fetch,
    sleep: (ms: number) => Promise<void> = defaultSleep,
    appVersion: string = DEFAULT_APP_VERSION,
  ) {
    super("bigmodel", fetchImpl, sleep, appVersion);
  }
}

// ---------------------------------------------------------------------------
// Bigmodel — classic auth-code flow with a localhost callback server
// (paste-login fallback; the primary path for both providers is the poll
// flow above, mirroring the 3.12.3 desktop)
// ---------------------------------------------------------------------------

/**
 * Per-provider auth-code configuration (Bigmodel paste login only — both
 * providers moved to the poll flow as their primary login).
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
// Headless paste login (auth-code flow)
// ---------------------------------------------------------------------------

/**
 * Parse a callback URL the user pasted back into the terminal (headless
 * `--paste` login, mirroring gcloud/gh CLI). Only the query string is
 * inspected — the pathname/host are whatever the browser's address bar shows
 * and are never validated. Tolerates copy artifacts from web pages: wrapping
 * quotes/brackets, surrounding whitespace, and `&amp;` entities (a paste from
 * a rendered page splits the query at the `&` inside `&amp;`, which breaks
 * `state`). Returns the auth code (`authCode` or `code` param); throws on a
 * CSRF `state` mismatch or a missing code.
 */
export function parsePastedCallbackUrl(raw: string, expectedState: string): string {
  let text = raw.trim().replace(/^["'`<([{]+/, "").replace(/["'`>\])}]+$/, "");
  text = text.replace(/&amp;/gi, "&");

  const q = text.indexOf("?");
  const query = (q >= 0 ? text.slice(q + 1) : text).split("#")[0];
  const params = new URLSearchParams(query);

  const state = params.get("state") ?? "";
  if (!state || state !== expectedState) {
    throw new Error(
      "OAuth state mismatch — the pasted URL does not belong to this login " +
      "session (possible CSRF). Retry the login.",
    );
  }

  const providerError = params.get("error");
  const code = params.get("authCode") ?? params.get("code") ?? "";
  if (!code) {
    throw new Error(
      providerError
        ? `Authorization failed: provider returned error=${providerError}`
        : "No authorization code in the pasted URL — paste the redirected " +
          "127.0.0.1 callback URL (the one that failed to load), not the authorize URL.",
    );
  }
  return code;
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
