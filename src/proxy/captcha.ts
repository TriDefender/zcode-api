/**
 * Aliyun Captcha V3 front-end -- config fetch + pre-solved token pool.
 *
 * Solving itself lives in captcha-happy.ts (in-process happy-dom solver,
 * production-proven, self-contained: bundled into the single-file release
 * binary -- no external Node.js, no browser, no jsdom). Tokens are minted
 * into a pool (captcha-pool.ts); requests take an already-solved token
 * (sub-ms) while background refills keep the pool warm -- the hot path
 * never waits on a solve.
 *
 * Fingerprint stability: the happy-dom solver's polyfill/guest-patch values
 * are deterministic and STABLE (never randomized) -- Aliyun's risk engine
 * correlates fingerprint stability across requests; randomizing per-solve
 * flags it as `verifyCode: F001`. See captcha-happy.ts.
 */
import { shutdownCaptchaSolver } from "./captcha-solver.js";
import {
  configureCaptchaPool,
  prefillCaptchaPool,
  takeCaptchaToken,
  startCaptchaPoolRefill,
  stopCaptchaPool,
  touchCaptchaDemand,
  type CaptchaConfig,
} from "./captcha-pool.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
// Config snapshot — mirrors the real client's host `getClientConfigs`
// (3.16.3 codingPlanSubscription): 1h TTL (`RRe=3600*1e3`), 15s timeout
// (`Js=15e3`), in-flight request dedup, and NO negative cache — a failed
// response said (absent captcha field included); only SUCCESSFUL fetches
// write it (§H 十轮; the old 60s TTL + 15s neg-cache was self-invented
// cadence refreshing 60× more often than the real client, and it manufactured
// the #002 "Captcha config unavailable" storm).
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let configsFetchInFlight: Promise<FetchedCaptchaConfig | null> | null = null;
// Last successfully fetched config, including an authoritative disable.
// Its region keeps serving pool takes through configs-fetch outages without
// resurrecting a previously enabled config after the server disables it.
let lastGoodCfg: FetchedCaptchaConfig | null = null;

type ConfigsFetch = typeof fetch;
let configsFetch: ConfigsFetch | null = null;
/** Test seam for the configs fetch — production code never calls this. */
export function __setConfigsFetchForTests(impl: ConfigsFetch | null): void {
  configsFetch = impl;
}

/** Test seam: clear the config caches — tests only. `keepLastGood` preserves
 *  the outage-fallback config (simulates snapshot expiry mid-outage). */
export function __resetCaptchaConfigCacheForTests(keepLastGood = false): void {
  cachedConfig = { value: null, expiresAt: 0 };
  configsFetchInFlight = null;
  if (!keepLastGood) lastGoodCfg = null;
}

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}


async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (configsFetchInFlight) return configsFetchInFlight;
  configsFetchInFlight = (async () => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the entire fetch, including the body. A response that sends
      // headers but stalls its JSON must not pin the shared in-flight promise.
      // Override: CAPTCHA_CONFIG_TIMEOUT_MS (mirror timeout 15s).
      const rawTimeoutMs = Number(process.env.CAPTCHA_CONFIG_TIMEOUT_MS || 15_000);
      const cfgTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 15_000;
      const readConfig = async (): Promise<unknown> => {
        const resp = await (configsFetch ?? fetch)(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`, { signal: controller.signal });
        if (!resp.ok || controller.signal.aborted) {
          void resp.body?.cancel().catch(() => {});
          throw new Error(`Captcha config request failed (${resp.status})`);
        }
        reader = resp.body?.getReader();
        const chunks: Uint8Array[] = [];
        try {
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          }
          return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        } finally {
          reader?.releaseLock();
          reader = undefined;
        }
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Captcha config request timed out"));
          controller.abort();
          void reader?.cancel().catch(() => {});
        }, cfgTimeoutMs);
      });
      const json = (await Promise.race([readConfig(), timeout])) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
      const cfg = json?.data?.configs?.captcha ?? null;
      // Snapshot write ONLY on a successful fetch (mirror: failures never
      // update the snapshot — the next call retries immediately).
      cachedConfig = { value: cfg, expiresAt: Date.now() + captchaConfigTtlMs() };
      if (cfg) lastGoodCfg = cfg;
      return cfg;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      configsFetchInFlight = null;
    }
  })();
  return configsFetchInFlight;
}

/** Snapshot TTL — mirror `RRe = 3600*1e3`. Override: CAPTCHA_CONFIG_TTL_MS. */
function captchaConfigTtlMs(): number {
  const raw = Number(process.env.CAPTCHA_CONFIG_TTL_MS || 3_600_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_600_000;
}

/**
 * Solve backend: in-process happy-dom (captcha-happy.ts) served through the
 * pre-solved token pool. Retries are handled inside the pool
 * (ZCODE_CAPTCHA_RETRIES attempts with a fresh solve per retry).
 *
 * Returns null when the fetched config DEFINITIVELY disables captcha
 * (`enabled:false`) or is active but missing any of region/prefix/sceneId
 * (3.18.0 renderer `qV` fail-open: the official captcha controller builds its
 * Aliyun SDK init from exactly these fields — a partial block means "no
 * captcha", NOTEPAD「3.18.0 增补」§C 复核修正) — no captcha headers is then the
 * correct wire shape. THROWS when acquisition failed for unknown reasons (pool
 * exhaustion with no config history) — callers must NOT dispatch a
 * captcha-less request on a throw: the start-plan edge answers those with
 * bare 502s (2026-10-23 live, NOTEPAD "3.16.3 增补" §H).
 *
 * Pool-first degradation: a configs-fetch outage never strands banked tokens
 * — with a last-good config on record the pool keeps serving (its region
 * rides along); the latest authoritative `enabled:false` remains disabled
 * through outages (§H 九轮: #002 live-烧 47s/16 次重试全因 configs 抖动，池内其实有货).
 */
export async function getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string } | null> {
  const cfg = (await fetchCaptchaConfig(appVersion)) ?? lastGoodCfg;
  if (!cfg) throw new Error("Captcha config unavailable");
  // 3.18.0 `qV` mirror: all three Aliyun init params must be present for the
  // official controller to solve; region feeds both the SDK init and the
  // X-Aliyun-Captcha-Verify-Region header, so a block without it fails open.
  if (!cfg.enabled || !cfg.region || !cfg.prefix || !cfg.sceneId) return null;
  return { verifyParam: await takeCaptchaToken(cfg), region: cfg.region };
}

export function shutdownCaptcha(): void {
  try { shutdownCaptchaSolver(); } catch {}
  try { stopCaptchaPool(); } catch {}
}

/**
 * In-flight request activity (an SSE response still producing): refresh the
 * pool's idle clock without taking a token, so a long stream never decays the
 * pool mid-turn (NOTEPAD "3.16.3 增补" §H). Cheap and inert pre-pool-start.
 */
export function noteDemand(): void {
  touchCaptchaDemand();
}

/**
 * Start background pre-solving of the token pool (happy backend).
 * Warms only the idle minimum; the pool grows on demand with traffic.
 */
export async function startCaptchaPool(appVersion: string): Promise<void> {
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled) return;
  // Size the pool before prefill: the module-level pool defers sizing to the
  // first configure() so a cold boot doesn't mint a storm of soon-expired
  // tokens. Defaults are sized for start-plan's 5-concurrent-request ceiling:
  // worst case ~10 instantaneous takes (5 requests + challenge retries), with
  // ~8-24 tokens circulating per 95s TTL -- 15 covers that plus F008/expiry
  // discards and bridges a pe-storm mint outage (~30-45s). Mint capacity
  // (~4-6/s at concurrency 3) stays an order of magnitude above demand.
  // CAPTCHA_POOL_MIN/CAPTCHA_POOL_MAX env vars override the defaults.
  const min = Number(process.env.CAPTCHA_POOL_MIN || 15);
  const max = Number(process.env.CAPTCHA_POOL_MAX || Math.max(min * 4, 60));
  configureCaptchaPool({ poolSizeMin: min, poolSizeMax: max });
  startCaptchaPoolRefill(cfg as CaptchaConfig);
  await prefillCaptchaPool(cfg as CaptchaConfig, min);
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
