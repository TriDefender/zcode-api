/**
 * Remote highspeed provider-config resolver — mirrors the official client's
 * zcode-builtin hot-update chain (bundle `U0r` client-config flow +
 * `NodeZCodeBuiltinProviderConfigSource.applyRemoteRelease`):
 *
 *   GET {origin}/api/v1/client/configs?app_version=&platform=
 *     → data.configs.builtin_provider_config_json   (CDN URL string)
 *     → fetch CDN → config.providerConfigRules.providerRules
 *     → account:{zai|bigmodel}-highspeed-card .config.api.baseUrl
 *
 * The official client applies CDN releases with revision gating and persists
 * them (its bundled zcode-builtin.json is only a fallback candidate), so a
 * server-side endpoint change propagates to clients without a package update.
 * We keep an in-memory 1h snapshot and ALWAYS fail open to the pinned default
 * (`highspeedLlmUrl`) — deliberate deviation: no on-disk persistence; a
 * restart simply re-resolves on the first eligible request.
 *
 * @see _reverse/NOTEPAD.md "C. HighSpeed 加速卡平面"（推理端点更正 + 热更新链）
 */

export type HighspeedFamily = "zai" | "bigmodel";

const CONFIGS_TIMEOUT_MS = 15_000; // host `da=15e3` (getClientConfigs apiClient timeout)
const CDN_TIMEOUT_MS = 20_000; // bundle `U0r` client-config flow timeout
const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // host clientConfigSnapshot TTL `zEe=3600e3`
const DEFAULT_PLATFORM = "win32-x64"; // captcha.ts client/configs convention

interface ProviderConfigSnapshot {
  bases: Partial<Record<HighspeedFamily, string>>;
  expiresAt: number;
}

let snapshot: ProviderConfigSnapshot | null = null;
let inFlight: Promise<void> | null = null;
/** Test seam for the HTTP fetch — production code never calls this. */
let providerConfigFetch: typeof fetch | null = null;

export function __setProviderConfigFetchForTests(impl: typeof fetch | null): void {
  providerConfigFetch = impl;
}

export function __resetHighspeedProviderConfigForTests(): void {
  snapshot = null;
  inFlight = null;
}

/**
 * Extract the per-family highspeed baseUrls from a zcode-builtin provider
 * config JSON (the CDN document the official client hot-applies). Returns an
 * empty object for any malformed shape — callers treat "absent" as
 * "keep the pinned default" (fail-open).
 */
export function extractHighspeedBaseUrls(json: unknown): Partial<Record<HighspeedFamily, string>> {
  const rules = (json as {
    config?: { providerConfigRules?: { providerRules?: unknown } };
  })?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return {};
  const bases: Partial<Record<HighspeedFamily, string>> = {};
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const id = (rule as { providerId?: unknown }).providerId;
    if (typeof id !== "string") continue;
    const family = id === "account:zai-highspeed-card" ? "zai"
      : id === "account:bigmodel-highspeed-card" ? "bigmodel"
        : null;
    if (!family) continue;
    const base = (rule as { config?: { api?: { baseUrl?: unknown } } })?.config?.api?.baseUrl;
    if (typeof base === "string" && base.trim()) bases[family] = base.trim();
  }
  return bases;
}

/** Resolve the two-stage fetch (configs → CDN) into a fresh snapshot. */
async function fetchSnapshot(opts: {
  origin: string;
  appVersion: string;
  platform: string;
  now: () => number;
}): Promise<ProviderConfigSnapshot | null> {
  const configsUrl = `${opts.origin.replace(/\/+$/u, "")}/api/v1/client/configs`
    + `?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`;

  const configsJson = (await fetchJson(configsUrl, CONFIGS_TIMEOUT_MS, "client/configs")) as {
    data?: { configs?: { builtin_provider_config_json?: unknown } };
  };
  const cdnUrl = configsJson?.data?.configs?.builtin_provider_config_json;
  if (typeof cdnUrl !== "string" || !cdnUrl.trim()) return null; // absent → keep default

  const cdnJson = await fetchJson(cdnUrl.trim(), CDN_TIMEOUT_MS, "provider-config cdn");
  const bases = extractHighspeedBaseUrls(cdnJson);
  if (!bases.zai && !bases.bigmodel) return null; // document without our entries → keep default
  return { bases, expiresAt: opts.now() + SNAPSHOT_TTL_MS };
}

/** Fetch + parse JSON, bounding headers AND body by `ms` (abort-linked). */
async function fetchJson(url: string, ms: number, what: string): Promise<unknown> {
  const doFetch = providerConfigFetch ?? fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pipeline = (async () => {
      const resp = await doFetch(url, { signal: controller.signal });
      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        throw new Error(`${what} HTTP ${resp.status}`);
      }
      return await resp.json();
    })();
    return await Promise.race([
      pipeline,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} fetch timed out`));
          controller.abort();
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget snapshot refresh. Never throws — any failure leaves the
 * previous snapshot (or none) in place and the next eligible request retries,
 * mirroring the client-config plane's no-negative-cache behavior.
 */
export function warmHighspeedProviderConfig(opts: {
  origin: string;
  appVersion: string;
  platform?: string;
  now?: () => number;
}): Promise<void> {
  const now = opts.now ?? Date.now;
  if (snapshot && snapshot.expiresAt > now()) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fresh = await fetchSnapshot({
        origin: opts.origin,
        appVersion: opts.appVersion,
        platform: opts.platform ?? DEFAULT_PLATFORM,
        now,
      });
      if (fresh) snapshot = fresh;
    } catch {
      // fail-open: keep default URL
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Carded-LLM URL override for this credential family, or null when no
 * snapshot has resolved (callers fall back to `HighspeedManager.llmUrl`).
 * Sync by design — mount sites must not await.
 */
export function resolvedHighspeedLlmUrl(family: HighspeedFamily): string | null {
  const base = snapshot?.bases[family];
  return base ? `${base.replace(/\/+$/u, "")}/v1/messages` : null;
}
