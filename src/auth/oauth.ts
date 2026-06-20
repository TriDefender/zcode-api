/**
 * OAuth flow handlers for Z.AI (device/poll) and Bigmodel (auth-code/callback).
 * @see .omo/plans/zcode-proxy.md Task 9
 * @see _reverse/NOTEPAD.md "Method 1: OAuth Flow"
 * @see _reverse/zcode.cjs: Act (createZaiCliOAuthClient), p3r (createBigmodelOAuthClient), Wro (loginBigmodelCodingPlan)
 */
import type { ProviderId } from "../provider/types.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from bundle)
// ---------------------------------------------------------------------------

const ZCODE_OAUTH_BASE = "https://zcode.z.ai/api/v1";
const BIGMODEL_HOST = "https://bigmodel.cn";
const BIGMODEL_APP_ID = "zcode";
const BIGMODEL_CALLBACK_PATH = "/oauth/callback/bigmodel";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface OAuthInitResponse {
  flowId: string;
  pollToken: string;
  authorizeUrl: string;
  expiresAt: number; // milliseconds
  pollIntervalSec: number;
}

export interface OAuthResult {
  accessToken: string;
  provider: ProviderId;
  /** Upstream user identifier, when the OAuth response included one. Passed through to `metadata.user_id` on Anthropic-format requests. */
  userId?: string;
  /** ZCode plan JWT for start-plan (zcode.z.ai). The OAuth poll/exchange response includes this alongside the provider access_token. */
  jwt?: string;
  /** Raw OAuth user object (email, avatar, …) for desktop credential sync. */
  user?: Record<string, unknown>;
}

export type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// Z.AI envelope helper — {code, data, msg}
// ---------------------------------------------------------------------------

interface ZaiEnvelope {
  code: number;
  data?: Record<string, unknown>;
  msg?: string;
}

/**
 * Validate and unwrap the Z.AI {code, data, msg} envelope.
 * @see bundle k3r (requestJsonEnvelope): code must be number, must be 0 for success.
 */
function unwrapZaiEnvelope(raw: unknown, httpStatus: number): Record<string, unknown> {
  const env = raw as ZaiEnvelope;
  if (typeof env?.code !== "number") {
    throw new Error(`Invalid OAuth response envelope (httpStatus=${httpStatus}): missing numeric code field`);
  }
  if (env.code !== 0) {
    throw new Error(env.msg ?? `OAuth business error: code=${env.code}`);
  }
  return env.data ?? {};
}

// ---------------------------------------------------------------------------
// Z.AI OAuth — device/poll flow (Act / createZaiCliOAuthClient)
// ---------------------------------------------------------------------------

/** Generate a random 32-byte hex poll token. @see bundle I3r / createZaiCliOAuthPollToken */
function generatePollToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Z.AI CLI OAuth client.
 *
 * Flow (from bundle Vro / loginZCodeCli):
 *   1. Client generates 32-byte hex pollToken
 *   2. POST /oauth/cli/init with Authorization: Bearer {pollToken}, body {provider:"zai"}
 *      Response: {code:0, data:{flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}}
 *   3. User opens authorize_url in browser
 *   4. GET /oauth/cli/poll/{flowId} with Authorization: Bearer {pollToken}
 *      Response: {code:0, data:{status:"pending"|"ready"|"failed", token, zai:{access_token}, user}}
 *   5. Extract zai.access_token for credential resolution
 */
export class ZaiOAuthClient {
  constructor(private fetchImpl: FetchFn = fetch) {}

  async init(provider: ProviderId = "zai"): Promise<OAuthInitResponse> {
    const pollToken = generatePollToken();

    const resp = await this.fetchImpl(`${ZCODE_OAUTH_BASE}/oauth/cli/init`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${pollToken}`,
      },
      body: JSON.stringify({ provider }),
    });

    const raw = safeJsonParse(await resp.text());
    if (!resp.ok) {
      const env = raw as ZaiEnvelope | null;
      throw new Error(
        `OAuth init failed: ${resp.status} ${env?.msg ?? ""}`.trim(),
      );
    }
    if (!raw) {
      throw new Error(`OAuth init failed: invalid JSON response (status ${resp.status})`);
    }

    // Unwrap {code, data, msg} envelope
    const data = unwrapZaiEnvelope(raw, resp.status);

    // Validate required fields (bundle parseInitData / $ro)
    if (
      typeof data.flow_id !== "string" ||
      typeof data.authorize_url !== "string" ||
      typeof data.expires_at !== "number" ||
      typeof data.poll_interval_sec !== "number"
    ) {
      throw new Error(
        `Invalid OAuth init data: ${JSON.stringify(data).substring(0, 200)}`,
      );
    }

    // expires_at is in seconds (bundle: initData.expires_at * 1e3)
    return {
      flowId: data.flow_id,
      pollToken,
      authorizeUrl: data.authorize_url,
      expiresAt: data.expires_at * 1000,
      pollIntervalSec: data.poll_interval_sec,
    };
  }

  async poll(flowId: string, pollToken: string): Promise<{
    status: "pending" | "ready" | "failed";
    token?: string;
    zai?: { access_token?: string };
    userId?: string;
    user?: Record<string, unknown>;
  }> {
    const resp = await this.fetchImpl(
      `${ZCODE_OAUTH_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${pollToken}` },
      },
    );

    const raw = safeJsonParse(await resp.text());
    if (!resp.ok) {
      // 400/408/404 -> treat as failed/expired rather than fatal
      if (resp.status === 400 || resp.status === 408 || resp.status === 404) {
        return { status: "failed" as const };
      }
      const env = raw as ZaiEnvelope | null;
      throw new Error(
        `OAuth poll failed: ${resp.status} ${env?.msg ?? ""}`.trim(),
      );
    }
    if (!raw) {
      throw new Error(`OAuth poll failed: invalid JSON response (status ${resp.status})`);
    }

    // Unwrap envelope
    const data = unwrapZaiEnvelope(raw, resp.status);
    const status = data.status as string;

    if (status === "pending" || status === "failed") {
      return { status };
    }
    if (status === "ready") {
      const user = data.user as Record<string, unknown> | undefined;
      const userId =
        typeof user?.user_id === "string"
          ? user.user_id
          : typeof user?.user_id === "number"
            ? String(user.user_id)
            : undefined;
      return {
        status: "ready",
        token: data.token as string | undefined,
        zai: data.zai as { access_token?: string } | undefined,
        userId,
        user,
      };
    }

    throw new Error(`Invalid OAuth poll status: ${status}`);
  }

  async waitForAuth(
    init: OAuthInitResponse,
    onAuthorizeUrl?: (url: string) => void,
  ): Promise<OAuthResult> {
    onAuthorizeUrl?.(init.authorizeUrl);

    const deadline = init.expiresAt;
    const intervalMs = Math.max(1000, init.pollIntervalSec * 1000);

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const result = await this.poll(init.flowId, init.pollToken);

      if (result.status === "ready") {
        const accessToken = result.zai?.access_token ?? result.token;
        if (!accessToken || typeof accessToken !== "string") {
          throw new Error("OAuth ready but no access_token in response");
        }
        return {
          accessToken,
          provider: "zai",
          userId: result.userId,
          jwt: result.token,
          user: result.user,
        };
      }
      if (result.status === "failed") {
        throw new Error("Authorization failed. Please retry login.");
      }
      // pending -> keep polling
    }
    throw new Error("Authorization timed out. Please retry login.");
  }
}

// ---------------------------------------------------------------------------
// Bigmodel OAuth — via zcode.z.ai proxy (Electron host process flow)
// ---------------------------------------------------------------------------

const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";

/**
 * Bigmodel OAuth client.
 *
 * The ZCode Electron app proxies the Bigmodel OAuth token exchange through
 * zcode.z.ai so the appSecret stays server-side. We replicate that flow:
 *
 *   1. Start localhost HTTP server on random port
 *   2. Build authorize URL: bigmodel.cn/login?appId=zcode&redirect={localhost}&state={state}
 *   3. User opens URL, authorizes on bigmodel.cn
 *   4. Bigmodel redirects to localhost callback with ?code=...&state=...
 *   5. POST https://zcode.z.ai/api/v1/oauth/token
 *      body: {provider:"bigmodel", code, redirect_uri, state}
 *   6. zcode.z.ai server uses its own appSecret to exchange with Bigmodel
 *   7. Returns access_token
 *
 * @see ~/.zcode/v2/logs — [bigmodelOAuth] zcode token request
 */
export class BigmodelOAuthClient {
  private server: Server | null = null;

  constructor(
    private fetchImpl: FetchFn = fetch,
    private host: string = BIGMODEL_HOST,
    private appId: string = BIGMODEL_APP_ID,
  ) {}

  /**
   * Run the full Bigmodel OAuth flow: start callback server, return authorize URL.
   * Call waitForCallback() afterwards, then close().
   */
  async start(): Promise<{ authorizeUrl: string; callbackUrl: string; state: string }> {
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
        const port = addr.port;
        const callbackUrl = `http://127.0.0.1:${port}${BIGMODEL_CALLBACK_PATH}`;

        const params = new URLSearchParams({
          appId: this.appId,
          redirect: callbackUrl,
          state,
        });
        const authorizeUrl = `${this.host}/login?${params.toString()}`;

        resolve({ authorizeUrl, callbackUrl, state });
      });
    });
  }

  private callbackResult: { code: string; error: string | null } | null = null;
  private callbackWaiters: Array<(result: { code: string; error: string | null }) => void> = [];

  private handleCallback(req: IncomingMessage, res: ServerResponse, expectedState: string): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== BIGMODEL_CALLBACK_PATH) {
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

  /** Wait for the OAuth callback redirect. Resolves with authCode. */
  async waitForCallback(timeoutMs: number = 300_000): Promise<string> {
    if (this.callbackResult?.code) {
      return this.callbackResult.code;
    }
    if (this.callbackResult?.error) {
      throw new Error(this.callbackResult.error);
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
   * Exchange auth code via zcode.z.ai proxy.
   * The ZCode server holds the appSecret and performs the real Bigmodel exchange.
   * Returns `{ accessToken, userId }` — userId is captured from the response's
   * `data.user.user_id` when present.
   */
  async exchangeCode(
    authCode: string,
    redirectUri: string,
    state: string,
  ): Promise<{ accessToken: string; userId?: string; jwt?: string }> {
    const resp = await this.fetchImpl(ZCODE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "bigmodel",
        code: authCode,
        redirect_uri: redirectUri,
        state,
      }),
    });

    const raw = safeJsonParse(await resp.text()) as {
      code?: number;
      data?: {
        token?: string;
        user?: { user_id?: string };
        bigmodel?: { access_token?: string };
      };
      msg?: string;
    } | null;

    if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
      throw new Error(
        `Bigmodel token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`,
      );
    }

    const accessToken = raw?.data?.bigmodel?.access_token?.trim() ?? "";

    if (!accessToken) {
      throw new Error("Bigmodel token response missing bigmodel.access_token");
    }
    const userId = raw?.data?.user?.user_id;
    const jwt = raw?.data?.token?.trim() ?? undefined;
    return { accessToken, userId: typeof userId === "string" ? userId : undefined, jwt };
  }

  async authorize(
    onAuthorizeUrl?: (url: string) => void,
    timeoutMs: number = 300_000,
  ): Promise<OAuthResult> {
    const { authorizeUrl, callbackUrl, state } = await this.start();
    onAuthorizeUrl?.(authorizeUrl);

    try {
      const authCode = await this.waitForCallback(timeoutMs);
      const { accessToken, userId, jwt } = await this.exchangeCode(authCode, callbackUrl, state);
      return { accessToken, provider: "bigmodel", userId, jwt };
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
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
