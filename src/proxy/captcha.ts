/**
 * Aliyun Captcha V3 front-end — config fetch + pre-solved token pool.
 *
 * Solving itself lives in captcha-happy.ts (in-process happy-dom solver,
 * production-proven, self-contained: bundled into the single-file release
 * binary — no external Node.js, no browser, no jsdom). Tokens are minted
 * into a pool (captcha-pool.ts); requests take an already-solved token
 * (sub-ms) while background refills keep the pool warm — the hot path
 * never waits on a solve.
 *
 * Fingerprint stability: the happy-dom solver's polyfill/guest-patch values
 * are deterministic and STABLE (never randomized) — Aliyun's risk engine
 * correlates fingerprint stability across requests; randomizing per-solve
 * flags it as `verifyCode: F001`. See captcha-happy.ts.
 */
import { shutdownCaptchaSolver } from "./captcha-solver.js";
import {
  configureCaptchaPool,
  getCaptchaPoolStats,
  prefillCaptchaPool,
  takeCaptchaToken,
  startCaptchaPoolRefill,
  stopCaptchaPool,
  urgentCaptchaRefill,
  type CaptchaConfig,
} from "./captcha-pool.js";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";

interface FetchedCaptchaConfig { enabled: boolean; prefix: string; sceneId: string; region: string; }
let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  return v && v.trim().length > 0 ? v.trim() : null;
}


async function fetchCaptchaConfig(appVersion: string): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  try {
    const resp = await fetch(`${CONFIGS_API}?app_version=${encodeURIComponent(appVersion)}&platform=win32-x64`);
    const json = (await resp.json()) as { data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch { return null; }
}

/**
 * Solve backend: in-process happy-dom (captcha-happy.ts) served through the
 * pre-solved token pool. Retries are handled inside the pool
 * (ZCODE_CAPTCHA_RETRIES attempts with a fresh solve per retry).
 */
export async function getCaptchaToken(appVersion: string): Promise<{ verifyParam: string; region: string }> {
  const cfg = await fetchCaptchaConfig(appVersion);
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) throw new Error("Captcha config unavailable");
  // Pre-solved token pool: requests take an already-minted token (sub-ms)
  // while background solves refill — the hot path never waits on a solve.
  const verifyParam = await takeCaptchaToken(cfg);
  return { verifyParam, region: cfg.region };
}

export function shutdownCaptcha(): void {
  try { shutdownCaptchaSolver(); } catch {}
  try { stopCaptchaPool(); } catch {}
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
  // tokens. CAPTCHA_POOL_MIN/CAPTCHA_POOL_MAX env vars override the defaults.
  const min = Number(process.env.CAPTCHA_POOL_MIN || 20);
  const max = Number(process.env.CAPTCHA_POOL_MAX || Math.max(min * 6, 120));
  configureCaptchaPool({ poolSizeMin: min, poolSizeMax: max });
  startCaptchaPoolRefill(cfg as CaptchaConfig);
  await prefillCaptchaPool(cfg as CaptchaConfig, min);
}

/** Request an urgent refill burst (e.g. after a challenge/retry). */
export function urgentCaptcha(): void {
  urgentCaptchaRefill();
}

export function captchaPoolStats(): { ready: number; target: number; activeSolves: number } {
  return getCaptchaPoolStats();
}

export function configureCaptchaSolving(opts: Parameters<typeof configureCaptchaPool>[0]): void {
  configureCaptchaPool(opts);
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
