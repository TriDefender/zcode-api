/**
 * Configuration types for zcode-proxy.
 * @see .omo/plans/zcode-proxy.md Task 2
 */

/** Provider endpoint configuration (one per upstream provider). */
export interface ProviderEndpoints {
  /** Base URL for Anthropic-format API, e.g. "https://api.z.ai/api/anthropic". */
  anthropicBase: string;
  /** Base URL for OpenAI-format API, e.g. "https://api.z.ai/api/coding/paas/v4". */
  openaiBase: string;
  /** Provider-specific credential override. If absent, uses the global `auth.apiKey`. */
  credential?: string;
}

/** Auth section of the proxy configuration. */
interface AuthConfig {
  /**
   * Key that clients must provide to use the proxy (via `Authorization: Bearer {proxyApiKey}`).
   * If unset, the proxy does not require client auth.
   */
  proxyApiKey?: string;
  /** How the proxy obtains the upstream credential. */
  mode: "apikey" | "oauth";
  /** Direct credential for `apikey` mode. Format: `{apiKey}` or `{apiKey}.{secret}` (Z.AI). */
  apiKey?: string;
  /** Path to stored OAuth credentials (for `oauth` mode). */
  oauthCredentialsPath?: string;
}

/**
 * Identity headers injected on every upstream request to mimic the ZCode
 * desktop client. Mirrors the `pio` builder in the reverse-engineered bundle
 * (`_reverse/zcode.cjs`); see `_reverse/NOTEPAD.md` "How Credential is Used".
 *
 * Resolution: env var (matches ZCode's own convention) → YAML override → default.
 * `appVersion` must be printable ASCII (`/^[\x20-\x7e]+$/`); non-conforming
 * values are silently dropped and fall back to the default (current ZCode
 * release), exactly like `fio` in the bundle.
 */
export interface ProxyIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
}

/** Local client-session inference mode for upstream session affinity. */
export interface ClientIdentityConfig {
  /** "observe" logs/instruments only; "enforce" reuses upstream x-session-id; "off" disables inference. */
  mode: "off" | "observe" | "enforce";
  /** In-memory session TTL in seconds. */
  ttlSeconds: number;
  /** Maximum number of inferred sessions retained in memory. */
  maxSessions: number;
}

/**
 * Responses-API (`/v1/responses`) configuration. When `enabled`, the proxy
 * translates Codex-style Responses requests to the GLM Chat Completions upstream.
 */
export interface ResponsesConfig {
  /** Enable the `/v1/responses` route. Default `true`. */
  enabled: boolean;
  /** Max stored responses (LRU). Default 1000. */
  storeMaxEntries: number;
  /** Stored-response TTL in ms. Default 24h (in-memory; cleared on restart). */
  storeTtlMs: number;
}

/** GLM MCP hosted-tool configuration. Endpoints are derived from the active provider. */
export interface McpConfig {
  /** Enable MCP interception (web_search) and function-tool injection (web_reader/zread). Default `true`. */
  enabled: boolean;
  /** Intercept `web_search` / `web_search_preview` hosted tools via GLM `web_search_prime` MCP. Default `true`. */
  webSearch: boolean;
  /** Inject `webReader` as a function tool the model can call. Default `false` (off by default to limit scope). */
  webReader: boolean;
  /** Inject the three `zread` tools as function tools. Default `false`. */
  zread: boolean;
}

/**
 * Async (off-peak / idle-plan) bridge configuration. When `enabled`, exposes
 * `/async/v1/messages` and `/async/v1/chat/completions` that route to ZCode's
 * off-peak ticket-queue backend. The proxy keeps the client connection alive
 * with SSE comments during ticket-queue wait, forwards the LLM stream once
 * the ticket is `ready`, and auto-retries on ticket-expired (up to `maxRetries`).
 *
 * Requires `auth.mode: oauth` (off-peak needs both `Authorization: Bearer ${jwt}`
 * and `X-Coding-Plan-Api-Key` headers). apikey-only mode lacks the JWT and the
 * route entry returns 400 `async_credentials_unavailable`.
 *
 * @see _reverse/NOTEPAD.md "Off-Peak / Idle Plan" section for full upstream protocol.
 */
export interface AsyncConfig {
  /** Enable the `/async/*` routes. Default `false`. */
  enabled: boolean;
  /** Base origin for off-peak endpoints. Default `"https://zcode.z.ai"`. */
  origin: string;
  /** Ticket-status poll interval in ms. Default `5000`. */
  pollIntervalMs: number;
  /** SSE keepalive comment interval during ticket-queue wait, in ms. Default `3000`. */
  keepAliveIntervalMs: number;
  /** Maximum total wait time for a ticket to become `ready`, in ms. `0` = unlimited. Default `0`. */
  maxWaitMs: number;
  /** Maximum auto-retry count on `off-peak-ticket-expired`. Default `3`. */
  maxRetries: number;
  /** Settle call timeout in ms (best-effort close-out on completion/abort). Default `8000`. */
  settleTimeoutMs: number;
  /** Control-plane call (takeTicket/pollStatus) timeout in ms. Default `15000`. */
  controlTimeoutMs: number;
  /** Optional model override; empty string uses the request's `model`. Default `""`. */
  defaultModel: string;
}

/** Top-level proxy configuration. */
export interface ProxyConfig {
  server: {
    port: number;
    host: string;
  };
  auth: AuthConfig;
  /** Active upstream provider. */
  provider: "zai" | "bigmodel";
  /** Which plan tier to use. "coding-plan" (default) uses direct upstream endpoints; "start-plan" routes through zcode.z.ai with JWT auth. */
  plan: "coding-plan" | "start-plan";
  /** Per-provider endpoint overrides. */
  providers: {
    zai: ProviderEndpoints;
    bigmodel: ProviderEndpoints;
  };
  /** Default model id used when client request omits `model`. */
  defaultModel: string;
  /** Whitelist of allowed model ids. */
  models: string[];
  /**
   * Identity headers injected upstream. Always present after `loadConfig`;
   * defaults mirror the production ZCode desktop client.
   */
  identity: ProxyIdentity;
  /** Local client session inference for cache-affinity experiments. */
  clientIdentity: ClientIdentityConfig;
  /** Responses-API (`/v1/responses`) configuration. */
  responses: ResponsesConfig;
  /** GLM MCP hosted-tool configuration. */
  mcp: McpConfig;
  /** Async (off-peak / idle-plan) bridge configuration. */
  async: AsyncConfig;
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
}
