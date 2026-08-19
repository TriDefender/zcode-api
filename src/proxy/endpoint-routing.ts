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
import { buildIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const DEFAULT_ORIGIN = "https://zcode.z.ai";
const CONFIG_PATH = "/api/v1/agent/configs";
const SUCCESS_TTL_MS = 300_000;
const FAILURE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_MAPPING_ENTRIES = 256;

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
}

interface RoutingSnapshot {
  expiresAt: number;
  mapping: Map<string, string>;
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

export class EndpointRoutingService {
  private readonly configUrl: string;
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

  /**
   * Resolve a request URL through the mapping table. Never throws: any error
   * resolves to `{ routed: false, url }` so the caller keeps the original URL.
   * The optional `credential` (coding-plan key) is attached as `x-api-key` on
   * a mapping refresh fetch, mirroring the client's `sourceHeaders`.
   */
  async resolve(url: string, credential?: string): Promise<RoutedUrl> {
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
    const rewritten = new URL(target);
    rewritten.search = parsed.search;
    return { routed: true, url: rewritten.href };
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
    const headers: Record<string, string> = {
      accept: "application/json",
      ...buildIdentityHeaders(this.identity),
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
      const data = envelope.data as { proxyEndpoint?: { mapping?: unknown } } | undefined;
      const entries = data?.proxyEndpoint?.mapping;
      const list = Array.isArray(entries) ? entries : [];
      if (list.length > MAX_MAPPING_ENTRIES) throw new Error("agent_configs_too_many_mappings");

      const mapping = new Map<string, string>();
      for (const entry of list) {
        const raw = entry as { from?: unknown; to?: unknown };
        const from = parseMappingUrl(raw.from, "from");
        const to = parseMappingUrl(raw.to, "to");
        const key = routingKey(from);
        if (mapping.has(key)) throw new Error("agent_configs_duplicate_from");
        mapping.set(key, to.href);
      }
      this.snapshot = { expiresAt: this.now() + this.successTtlMs, mapping };
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

function identityCacheKey(identity: ProxyIdentity): string {
  return JSON.stringify([identity.appVersion, identity.sourceTitle, identity.refererOrigin, identity.deviceMid ?? ""]);
}

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
