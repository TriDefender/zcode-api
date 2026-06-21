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
export interface AuthConfig {
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
 * desktop client. Mirrors the `eYn` builder in the reverse-engineered bundle
 * (`_reverse/zcode.cjs`); see `_reverse/NOTEPAD.md` "How Credential is Used".
 *
 * Resolution: env var (matches ZCode's own convention) → YAML override → default.
 * `appVersion` must be printable ASCII (`/^[\x20-\x7e]+$/`); non-conforming
 * values are silently dropped and fall back to the default (current ZCode
 * release), exactly like `rYn` in the bundle.
 */
export interface ProxyIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
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
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  /** Start-plan multi-account pool (optional). */
  pool?: {
    /** Enable JWT account rotation for start-plan (default: true when accounts exist). */
    enabled?: boolean;
    /** Max accounts to try per client request (default 5). */
    maxAccountAttempts?: number;
    /** How often to run a full staggered billing refresh cycle (seconds, default 300). */
    quotaRefreshIntervalSec?: number;
    /** Delay between each account billing API call within a cycle (seconds, default 5). */
    quotaFetchDelaySec?: number;
  };
}
