/**
 * Provider endpoint routing — mirrors the ZCode 3.7+ `ProviderEndpointRoutingService`.
 *
 * The desktop client periodically fetches `GET {zcodeApiBase}/api/v1/agent/configs`
 * and rewrites provider request URLs according to the returned
 * `data.proxyEndpoint.mapping` table (`from` → `to`, exact normalized-URL match).
 * As of 2026-08-19 the server maps the coding-plan Anthropic endpoints to
 * `zcode.z.ai/api/v1/ultra[-zai]/...`; the table is server-controlled and may
 * grow at any time, so resolution is generic.
 *
 * Failure semantics are strictly fail-open: any fetch/parse error keeps the
 * previous snapshot (or none) and requests go to their original URL after a
 * cooldown. See `_reverse/NOTEPAD.md` "Server-side endpoint remapping".
 */
import { buildIdentityHeaders, identityCacheKey } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const CONFIG_PATH = "/api/v1/agent/configs";
const SUCCESS_TTL_MS = 300_000;
const FAILURE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_MAPPING_ENTRIES = 256;

/**
 * 3.16.2 `zcodeAuthorizationHeader` (bundle `sso`/`DGs`/`OGs`): the server may
 * flag a mapping entry to have the zcode JWT attached as
 * `X-ZCode-Authorization: Bearer <jwt>` on rewritten requests. The field VALUE
 * is a marker — it must equal the header name itself (case-insensitive), not a
 * credential — and the target must stay on the official ultra paths, otherwise
 * the whole config refresh is rejected (`agent_configs_unsafe_zcode_authorization_target`,
 * fail-closed on config / fail-open on request, exactly like the client).
 */
const ZCODE_AUTHORIZATION_HEADER = "X-ZCode-Authorization";
const ZCODE_AUTHORIZATION_MARKER = "x-zcode-authorization";
const ZCODE_AUTHORIZATION_PATHS = ["/api/v1/ultra", "/api/v1/ultra-zai"];

export interface EndpointRoutingOptions {
  /** Origin of the agent-configs endpoint. */
  origin?: string;
  identity: ProxyIdentity;
  /** Resolves the `x-api-key` sent on the config fetch (coding-plan credential). */
  credential?: () => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  successTtlMs?: number;
  failureCooldownMs?: number;
  requestTimeoutMs?: number;
  onSnapshot?: (entries: number) => void;
}

export interface RoutedUrl {
  routed: boolean;
  url: string;
  /**
   * Extra headers the server asked for via the mapping entry's
   * `zcodeAuthorizationHeader` flag (3.16.2). Present only when the matched
   * entry is flagged AND a printable zcode JWT was supplied — absent
   * otherwise (fail-open: routing still applies).
   */
  headers?: Record<string, string>;
}

interface RoutingTarget {
  url: string;
  includeZCodeAuthorization: boolean;
}

/**
 * 3.16.3 request-verification switch (bundle `$rs` → 3.18.0 `I1r`
 * readRequestVerificationConfig): agent/configs `data.configs.captcha` →
 * camelCase. The two booleans drive the gate (bundle `aws`
 * requiresRequestVerification: `enabled !== false` / `skipModelRequest !==
 * true`). 3.18.0 additionally carries `region`/`prefix`/`sceneId` — the
 * renderer captcha controller builds its Aliyun SDK init from exactly these
 * (NOTEPAD「3.18.0 增补」§C 复核修正), so they are passed through when present
 * as non-empty strings (the `ows` validator's active-block requirement).
 */
export interface RequestVerificationConfig {
  enabled?: boolean;
  skipModelRequest?: boolean;
  /** 3.18.0 Aliyun captcha init params — solver consumes them when the block ships. */
  region?: string;
  prefix?: string;
  sceneId?: string;
}

interface RoutingSnapshot {
  expiresAt: number;
  mapping: Map<string, RoutingTarget>;
  /**
   * 3.16.3 `data.configs.captcha`, parsed on the same fetch. `null` while the
   * server has not shipped the block (live state as of 2026-10-23) — consumers
   * must treat that as "keep the pre-3.16.3 wire".
   */
  requestVerification: RequestVerificationConfig | null;
}

/** bundle `$rs`: `configs.captcha` object → switch; anything else → null. Cannot throw. */
function parseRequestVerificationConfig(configs: unknown): RequestVerificationConfig | null {
  const captcha = (configs as { captcha?: unknown } | null | undefined)?.captcha;
  if (captcha === null || typeof captcha !== "object" || Array.isArray(captcha)) return null;
  const { skip_model_request, ...rest } = captcha as Record<string, unknown>;
  const out: RequestVerificationConfig = {};
  if (typeof rest.enabled === "boolean") out.enabled = rest.enabled;
  if (typeof skip_model_request === "boolean") out.skipModelRequest = skip_model_request;
  // 3.18.0: Aliyun init params ride the same block (`ows` demands non-empty
  // strings when the block is active) — keep only well-formed values; the
  // solver-side gate (captcha.ts) fails open on any missing one.
  for (const key of ["region", "prefix", "sceneId"] as const) {
    const v = rest[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return out;
}

/**
 * 3.16.3 `requiresRequestVerification` (bundle `a5`/`Vrs`, chunk `a5`) applied
 * to the claim plane. DELIBERATE DEVIATION: the official gate's first condition
 * `e?.mode === "start-plan"` is dropped — our claim requests are always that
 * account mode, so it is constant-true here. Absent config (block not shipped /
 * fetch failed / routing disabled) → verification required — byte-identical to
 * the pre-3.16.3 behavior.
 */
export function requiresClaimCaptcha(config: RequestVerificationConfig | null | undefined): boolean {
  return config?.enabled !== false && config?.skipModelRequest !== true;
}

function normalizePath(pathname: string): string {
  if (pathname === "/") return "/";
  return pathname.replace(/\/+$/u, "") || "/";
}

function routingKey(url: URL): string {
  const port = url.port || "443";
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}${normalizePath(url.pathname)}`;
}

function parseMappingUrl(value: unknown, field: "from" | "to"): URL {
  if (typeof value !== "string") throw new Error(`mapping.${field} must be a string`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`mapping.${field} URL is not a plain https URL`);
  }
  return parsed;
}

// bundle `OGs`=isAllowedIdentityTarget: origin must equal the config origin and
// the normalized pathname must be an official ultra path (exact or subpath).
function isAllowedZCodeAuthorizationTarget(target: URL, endpointOrigin: string): boolean {
  if (target.origin !== endpointOrigin) return false;
  const path = normalizePath(target.pathname);
  return ZCODE_AUTHORIZATION_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

// bundle `Mpt`=normalizePrintableHeaderValue: trimmed, fully printable ASCII or null.
function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

// bundle `readZCodeAuthorization`: printable gate + Bearer normalization,
// fail-open (no header when the JWT is missing/unreadable).
function buildZCodeAuthorizationHeaders(zcodeJwt: string | undefined): Record<string, string> | undefined {
  const value = normalizePrintableHeaderValue(zcodeJwt);
  if (!value) return undefined;
  return { [ZCODE_AUTHORIZATION_HEADER]: /^Bearer\s/i.test(value) ? value : `Bearer ${value}` };
}

export class EndpointRoutingService {
  private readonly configUrl: string;
  private readonly endpointOrigin: string;
  private readonly identity: ProxyIdentity;
  private readonly credential?: () => string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureCooldownMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onSnapshot?: (entries: number) => void;
  private snapshot: RoutingSnapshot | undefined;
  private retryAfter = 0;
  private refreshPromise: Promise<void> | undefined;

  constructor(opts: EndpointRoutingOptions) {
    this.configUrl = `${(opts.origin?.trim() || DEFAULT_ORIGIN).replace(/\/+$/u, "")}${CONFIG_PATH}`;
    this.endpointOrigin = new URL(this.configUrl).origin;
    this.identity = opts.identity;
    this.credential = opts.credential;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.successTtlMs = opts.successTtlMs ?? SUCCESS_TTL_MS;
    this.failureCooldownMs = opts.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onSnapshot = opts.onSnapshot;
  }

  /** True when at least one successful snapshot has been fetched. */
  hasSnapshot(): boolean {
    return this.snapshot !== undefined;
  }

  async getRequestVerificationConfig(credential?: string): Promise<RequestVerificationConfig | null> {
    try {
      await this.ensureFresh(credential);
    } catch {
      // fail-open: read whatever snapshot we have
    }
    return this.snapshot?.requestVerification ?? null;
  }

  /**
   * Resolve a request URL through the mapping table. Never throws: any error
   * resolves to `{ routed: false, url }` so the caller keeps the original URL.
   * The optional `credential` (coding-plan key) is attached as `x-api-key` on
   * a mapping refresh fetch, mirroring the client's `sourceHeaders`.
   * `zcodeJwt` (the `zcodejwttoken` slot) feeds the 3.16.2
   * `X-ZCode-Authorization` injection on flagged entries — omitted silently
   * when absent (the un-logged-in client behaves the same).
   */
  async resolve(url: string, credential?: string, zcodeJwt?: string): Promise<RoutedUrl> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { routed: false, url };
    }
    try {
      await this.ensureFresh(credential);
    } catch {
      // fail-open: resolve without a snapshot
    }
    const target = this.snapshot?.mapping.get(routingKey(parsed));
    if (!target) return { routed: false, url };
    const rewritten = new URL(target.url);
    rewritten.search = parsed.search;
    const headers = target.includeZCodeAuthorization ? buildZCodeAuthorizationHeaders(zcodeJwt) : undefined;
    return headers ? { routed: true, url: rewritten.href, headers } : { routed: true, url: rewritten.href };
  }

  private async ensureFresh(credential?: string): Promise<void> {
    const now = this.now();
    if ((this.snapshot && this.snapshot.expiresAt > now) || this.retryAfter > now) return;
    const pending = this.refreshPromise ?? this.beginRefresh(credential);
    await pending;
  }

  private beginRefresh(credential?: string): Promise<void> {
    const promise = this.refresh(credential).finally(() => {
      if (this.refreshPromise === promise) this.refreshPromise = undefined;
    });
    this.refreshPromise = promise;
    return promise;
  }

  private async refresh(credential?: string): Promise<void> {
    // 3.12.3: the config fetch's sourceHeaders come from `V6n` → the `TV`
    // context set (no X-ZCode-Agent, optional X-Device-Mid); the request adds
    // x-api-key + Accept.
    const headers: Record<string, string> = {
      ...buildIdentityHeaders(this.identity),
      Accept: "application/json",
    };
    const key = credential ?? this.credential?.();
    if (key) headers["x-api-key"] = key;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const resp = await this.fetchImpl(this.configUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status < 200 || resp.status >= 300) throw new Error(`agent_configs_http_${resp.status}`);
      const parsed = await resp.json() as unknown;
      const envelope = parsed as { code?: unknown; data?: unknown };
      if (!envelope || typeof envelope !== "object" || envelope.code !== 0) {
        throw new Error("agent_configs_nonzero_code");
      }
      const data = envelope.data as { proxyEndpoint?: { mapping?: unknown }; configs?: unknown } | undefined;
      const entries = data?.proxyEndpoint?.mapping;
      const list = Array.isArray(entries) ? entries : [];
      if (list.length > MAX_MAPPING_ENTRIES) throw new Error("agent_configs_too_many_mappings");

      const mapping = new Map<string, RoutingTarget>();
      for (const entry of list) {
        const raw = entry as { from?: unknown; to?: unknown; zcodeAuthorizationHeader?: unknown };
        const from = parseMappingUrl(raw.from, "from");
        const to = parseMappingUrl(raw.to, "to");
        if (raw.zcodeAuthorizationHeader !== undefined && typeof raw.zcodeAuthorizationHeader !== "string") {
          throw new Error("agent_configs_invalid_zcode_authorization_header");
        }
        const marker = raw.zcodeAuthorizationHeader?.trim() ?? "";
        const includeZCodeAuthorization = marker.length > 0;
        if (includeZCodeAuthorization
          && (marker.toLowerCase() !== ZCODE_AUTHORIZATION_MARKER
            || !isAllowedZCodeAuthorizationTarget(to, this.endpointOrigin))) {
          throw new Error("agent_configs_unsafe_zcode_authorization_target");
        }
        const key = routingKey(from);
        if (mapping.has(key)) throw new Error("agent_configs_duplicate_from");
        mapping.set(key, { url: to.href, includeZCodeAuthorization });
      }
      this.snapshot = {
        expiresAt: this.now() + this.successTtlMs,
        mapping,
        requestVerification: parseRequestVerificationConfig(data?.configs),
      };
      this.retryAfter = 0;
      this.onSnapshot?.(mapping.size);
    } catch {
      this.retryAfter = this.now() + this.failureCooldownMs;
    } finally {
      clearTimeout(timer);
    }
  }
}

let defaultRouting: EndpointRoutingService | null = null;
let defaultRoutingKey = "";

/**
 * Process-wide routing service, shared across requests (snapshot cache).
 * Recreated when the relevant config values change (Android `setConfig`) —
 * keyed on the full identity because the service embeds it in config-fetch
 * headers. Returns `null` when disabled.
 */
export function getDefaultEndpointRouting(config: {
  endpointRouting: { enabled: boolean; origin: string };
  identity: ProxyIdentity;
}): EndpointRoutingService | null {
  if (!config.endpointRouting.enabled) return null;
  const key = `${config.endpointRouting.origin}\n${identityCacheKey(config.identity)}`;
  if (!defaultRouting || key !== defaultRoutingKey) {
    defaultRouting = new EndpointRoutingService({
      origin: config.endpointRouting.origin,
      identity: config.identity,
    });
    defaultRoutingKey = key;
  }
  return defaultRouting;
}
