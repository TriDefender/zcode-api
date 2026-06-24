/**
 * OAuth flow handlers for Z.AI and Bigmodel.
 *
 * Both providers use the **same auth-code flow** (verified against the ZCode
 * 3.1.x desktop bundle, `out/host/index.js` provider adapters): the client
 * starts a localhost callback server, opens the provider's authorize URL in a
 * browser, then exchanges the returned `code` at a shared zcode.z.ai token
 * endpoint. The previous Z.AI device/poll flow (`/oauth/cli/init` +
 * `/oauth/cli/poll`) was **removed upstream** — those endpoints now 404.
 *
 * Provider-specific bits are isolated in `AuthCodeConfig`:
 * - Z.AI:      authorize `chat.z.ai/api/oauth/authorize`, appId `client_P8X5CMWmlaRO9gyO-KSqtg`, token field `data.zai.access_token`
 * - Bigmodel:  authorize `bigmodel.cn/login`,             appId `zcode`,                       token field `data.bigmodel.access_token`
 *
 * @see _reverse/NOTEPAD.md "Method 1: OAuth Flow"
 */
import type { ProviderId } from "../provider/types.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from bundle)
// ---------------------------------------------------------------------------

/** Shared token-exchange endpoint (both providers). Bundle: `tokenUrl`. */
const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";
/** Default Bigmodel authorize host (bundle `BIGMODEL_OAUTH_AUTHORIZE_URL`). */
const BIGMODEL_HOST = "https://bigmodel.cn";
/** Default Bigmodel app id (bundle `BIGMODEL_OAUTH_APP_ID`). */
const BIGMODEL_APP_ID = "zcode";

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

/**
 * Per-provider auth-code configuration. Captures the only points where Z.AI and
 * Bigmodel diverge (verified against the ZCode 3.1.x bundle adapters `Fm`/`ed`).
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
  /**
   * Authorize query-param scheme (verified against the ZCode 3.1.x bundle —
   * the two adapters build the URL differently):
   * - `"oauth2"`: standard OAuth2 — `response_type=code&client_id&redirect_uri&state` (Z.AI, `chat.z.ai/api/oauth/authorize`)
   * - `"zcode"`: custom — `appId&redirect&state` (Bigmodel, `bigmodel.cn/login`)
   */
  readonly authorizeParamStyle: "oauth2" | "zcode";
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

// ---------------------------------------------------------------------------
// Shared auth-code client — Z.AI & Bigmodel use identical machinery
// ---------------------------------------------------------------------------

/**
 * Auth-code OAuth client: localhost callback server + token exchange.
 *
 * Flow (mirrors the ZCode desktop `oauthService`):
 *   1. Start localhost HTTP server on a random port
 *   2. Build authorize URL: `{authorizeUrl}?appId={appId}&redirect={localhost}&state={state}`
 *   3. User opens the URL, authorizes on the provider's site
 *   4. Provider redirects to localhost callback with `?authCode=...&state=...`
 *   5. POST `{tokenUrl}` body `{provider, code, redirect_uri, state}`
 *   6. zcode.z.ai exchanges (holding the app secret server-side) and returns
 *      `{code:0, data:{token:<jwt>, <provider>:{access_token}, user:{user_id}}}`
 */
export abstract class AuthCodeOAuthClient {
  private server: Server | null = null;
  private callbackResult: { code: string; error: string | null } | null = null;
  private callbackWaiters: Array<(result: { code: string; error: string | null }) => void> = [];

  constructor(
    protected readonly config: AuthCodeConfig,
    protected readonly fetchImpl: FetchFn = fetch,
  ) {}

  /** Build the provider authorize URL with the localhost redirect + state. */
  protected buildAuthorizeUrl(callbackUrl: string, state: string): string {
    const params =
      this.config.authorizeParamStyle === "oauth2"
        ? new URLSearchParams({
            redirect_uri: callbackUrl,
            response_type: "code",
            client_id: this.config.appId,
            state,
          })
        : new URLSearchParams({
            appId: this.config.appId,
            redirect: callbackUrl,
            state,
          });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Start the localhost callback server and return the authorize URL.
   * Call `waitForCallback()` (or `authorize()`) afterwards, then `close()`.
   */
  start(): Promise<{ authorizeUrl: string; callbackUrl: string; state: string }> {
    const state = randomBytes(32).toString("hex");

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleCallback(req, res, state);
      });

      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
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
  waitForCallback(timeoutMs: number = 300_000): Promise<string> {
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
  ): Promise<{ accessToken: string; userId?: string; jwt?: string }> {
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

  /** Run the full flow: start server, surface authorize URL, exchange code. */
  async authorize(
    onAuthorizeUrl?: (url: string) => void,
    timeoutMs: number = 300_000,
  ): Promise<OAuthResult> {
    const { authorizeUrl, callbackUrl, state } = await this.start();
    onAuthorizeUrl?.(authorizeUrl);

    try {
      const authCode = await this.waitForCallback(timeoutMs);
      const { accessToken, userId, jwt } = await this.exchangeCode(authCode, callbackUrl, state);
      return { accessToken, provider: this.config.provider, userId, jwt };
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider configs (verified against ZCode 3.1.x bundle `out/host/index.js`)
// ---------------------------------------------------------------------------

/**
 * Z.AI auth-code config.
 * Bundle `Fm`: authorizeUrl `chat.z.ai/api/oauth/authorize`, appId
 * `client_P8X5CMWmlaRO9gyO-KSqtg`, token field `data.zai.access_token`.
 * (The legacy `oauth/cli/init` device/poll flow is gone — those endpoints 404.)
 */
const ZAI_AUTH_CODE_CONFIG: AuthCodeConfig = {
  provider: "zai",
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  tokenUrl: ZCODE_TOKEN_ENDPOINT,
  callbackPath: "/oauth/callback/zai",
  accessTokenField: "zai",
  authorizeParamStyle: "oauth2",
};

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
  authorizeParamStyle: "zcode",
};

/** Z.AI OAuth client (auth-code flow via chat.z.ai + zcode.z.ai token exchange). */
export class ZaiOAuthClient extends AuthCodeOAuthClient {
  constructor(fetchImpl: FetchFn = fetch) {
    super(ZAI_AUTH_CODE_CONFIG, fetchImpl);
  }
}

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

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
