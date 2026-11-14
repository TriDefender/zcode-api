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
 * - The bigmodel OAuth login (bigmodel.cn auth-code + poll) is DEPRECATED
 *   (decision 2026-11-14: superseded by the zai_cn "Z.ai (CN)" zchat login;
 *   the bigmodel flavor survives as a config/credential family only).
 * - 3.18.0 added a `zai_cn` login flavor on the desktop; as of 3.18.2 (live
 *   probes 2026-11-14) it is a first-class poll-login provider: `cli/init`
 *   `{provider:"zai_cn"}` returns a **China-region authorize host**,
 *   `zchat.z.ai/api/oauth/authorize` (plain `zai` still gets `chat.z.ai`),
 *   with callback `/oauth/cli/callback/zai_cn`; the interstitial keeps the
 *   `redirect_uri` param name (zai family) plus an extra `provider=zai_cn`
 *   query param (host bundle `t===Qr&&_.searchParams.set("provider",t)`).
 *   The poll payload is FAMILY-folded — the ready token sits under `data.zai`
 *   for the whole zai family (host poll normalizer `_c(provider)` branch; a
 *   live zai_cn ready poll carried no `data.zai_cn` key). DOWNSTREAM the
 *   zai_cn credential is BIGMODEL-family: `resolveStartPlanFamilyFromOAuthProvider`
 *   maps zai_cn → "bigmodel", the polled token is used AS-IS (no z/login
 *   exchange — `normalizePolledTokenSet`), and it authorizes the bigmodel.cn
 *   biz chain, surfacing the user's BigModel subscription (live-verified).
 *   See NOTEPAD「2026-11-14 增补」§D.
 *
 * @see _reverse/NOTEPAD.md "4. OAuth 流程"
 */
import type { LoginProviderId, ProviderId } from "../provider/types.js";
import { DEFAULT_APP_VERSION } from "../config/loader.js";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (from bundle)
// ---------------------------------------------------------------------------

/** zcode.z.ai API base (bundle `A3o`; cli-login + token endpoints hang off it). */
const ZCODE_API_BASE_ORIGIN = "https://zcode.z.ai";
const ZCODE_API_BASE = `${ZCODE_API_BASE_ORIGIN}/api/v1`;

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
  /** Zai-family poll payload linked BigModel credential — required by the zai_cn credential resolution. */
  linkedBigModel?: { customerId: string; accessToken: string };
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
  /**
   * Zai-family poll payload `data.bigmodel` (host: `x = _c(provider) ? Rw(l.bigmodel) : void 0`)
   * — the linked BigModel credential `{customer_id, access_token}` a Z.ai account carries
   * when linked to a BigModel account. The zai_cn credential's bigmodel-family material
   * resolves through THIS token (materialFromSnapshot: bigmodel-family
   * `accessToken = linkedBigModel.accessToken`), NOT through the zai-side accessToken.
   */
  linkedBigModel?: { customerId: string; accessToken: string };
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
      return {
        accessToken: tokens.accessToken,
        provider: this.provider,
        userId: tokens.userId,
        jwt: tokens.jwt,
        linkedBigModel: tokens.linkedBigModel,
      };
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
  /** Family bucket: BOTH zai and zai_cn flows surface their access_token here (host poll normalizer `_c(provider)` branch). */
  zai?: { access_token?: unknown };
  /**
   * Dual role: the login bucket for bigmodel flows, and — for zai-family
   * flows — the LINKED BigModel credential `{customer_id, access_token}`
   * (host `Rw(data.bigmodel)`), consumed by the zai_cn downstream chain.
   */
  bigmodel?: { access_token?: unknown; customer_id?: unknown };
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

/** zai_cn interstitial: the desktop interstitial plus `provider=zai_cn` (3.18.2 host `t===Qr` branch). */
function buildZaiCnInterstitialParam(appVersion: string): string {
  const url = new URL(buildDesktopOAuthRedirectParam(appVersion));
  url.searchParams.set("provider", "zai_cn");
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
class PollOAuthClient extends OAuthFlowClient {
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

  /**
   * Append the desktop interstitial param (3.18.2 host: `redirect_uri` for the
   * zai family — zai AND zai_cn, `redirect` for bigmodel). The zai_cn flavor
   * additionally carries `provider=zai_cn` ON the interstitial URL itself.
   */
  private applyInterstitial(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const interstitial =
      this.provider === "zai_cn"
        ? buildZaiCnInterstitialParam(this.appVersion)
        : buildDesktopOAuthRedirectParam(this.appVersion);
    url.searchParams.set(this.provider === "bigmodel" ? "redirect" : "redirect_uri", interstitial);
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
        // Payload keys are FAMILY-folded, not per-providerId: the 3.18.2 host
        // poll normalizer reads `data.zai` for the whole zai family —
        // `g = _c(provider) ? data.zai.access_token : data.bigmodel.access_token`
        // — so a zai_cn flow surfaces its token under `data.zai` too (the
        // per-providerId `e[t]` read found in the older glm CLI parser does
        // NOT match the host; verified live 2026-11-14: a zai_cn ready poll
        // carries no `data.zai_cn` key).
        const familyPayload = (
          this.provider === "bigmodel" ? data.bigmodel : data.zai
        ) as { access_token?: unknown } | undefined;
        const accessToken =
          typeof familyPayload?.access_token === "string" ? familyPayload.access_token.trim() : "";
        if (!accessToken) {
          const expectedKey = this.provider === "bigmodel" ? "bigmodel" : "zai";
          throw new Error(
            `${this.provider} login poll: response missing data.${expectedKey}.access_token ` +
            `(payload keys: ${Object.keys(data).join(", ") || "(none)"})`,
          );
        }
        // Mirror host `x = _c(n.provider) ? Rw(l.bigmodel) : void 0`: the whole
        // zai family also carries a linked BigModel credential in the SAME
        // payload. Rw semantics: absent → undefined; present-but-malformed →
        // throw (both customer_id and access_token required).
        let linkedBigModel: OAuthFlowTokens["linkedBigModel"];
        if (this.provider !== "bigmodel") {
          const raw = data.bigmodel;
          if (raw !== undefined && raw !== null) {
            if (typeof raw !== "object" || Array.isArray(raw)) {
              throw new Error("BigModel linked response invalid (not an object)");
            }
            const linkedRaw = raw as { customer_id?: unknown; access_token?: unknown };
            const customerId = typeof linkedRaw.customer_id === "string" ? linkedRaw.customer_id.trim() : "";
            const linkedToken = typeof linkedRaw.access_token === "string" ? linkedRaw.access_token.trim() : "";
            if (!customerId || !linkedToken) {
              throw new Error("BigModel linked response invalid: customer_id/access_token missing or empty");
            }
            linkedBigModel = { customerId, accessToken: linkedToken };
          }
        }
        return {
          accessToken,
          jwt: typeof data.token === "string" ? data.token.trim() : undefined,
          userId: typeof data.user?.user_id === "string" ? data.user.user_id : undefined,
          linkedBigModel,
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

/** Z.ai (CN) poll-flow login client — 3.18.2 desktop "Z.ai (CN)" flavor; cli/init issues the zchat.z.ai authorize host. */
export class ZaiCnOAuthClient extends PollOAuthClient {
  constructor(
    fetchImpl: FetchFn = fetch,
    sleep: (ms: number) => Promise<void> = defaultSleep,
    appVersion: string = DEFAULT_APP_VERSION,
  ) {
    super("zai_cn", fetchImpl, sleep, appVersion);
  }
}

/**
 * Poll-login client factory shared by every entrypoint (CLI / TUI / Android
 * control / login page) — replaces the per-call-site `provider === "bigmodel"`
 * ternaries. The provider id is sent verbatim to `cli/init` and keys the poll
 * payload, so adding a flavor only needs a `PollOAuthClient` subclass.
 */
export function createPollLoginClient(
  provider: LoginProviderId,
  fetchImpl: FetchFn = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): OAuthFlowClient {
  switch (provider) {
    case "zai":
      return new ZaiOAuthClient(fetchImpl, sleep);
    case "zai_cn":
      return new ZaiCnOAuthClient(fetchImpl, sleep);
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
