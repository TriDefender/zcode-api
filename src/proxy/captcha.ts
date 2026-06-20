/**
 * Aliyun Captcha V3 headless solver for start-plan tier.
 *
 * Proactive traceless verification via jsdom + AliyunCaptcha.js (scene 11xygtvd).
 * Config is auto-fetched from https://zcode.z.ai/api/v1/client/configs.
 *
 * @see https://github.com/TriDefender/zcode-api/issues/2
 */

import { invalidateJsdomCaptcha, solveCaptchaJsdom, type CaptchaConfig } from "./captcha-jsdom.js";

export const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
export const REGION_HEADER = "x-aliyun-captcha-verify-region";
export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };

const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
const DEFAULT_SCENE = "11xygtvd";
const DEFAULT_PREFIX = "no8xfe";
const DEFAULT_REGION = "sgp";

let cachedConfig: { value: CaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function fetchCaptchaConfig(): Promise<CaptchaConfig> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }

  const defaults: CaptchaConfig = {
    enabled: true,
    prefix: DEFAULT_PREFIX,
    sceneId: DEFAULT_SCENE,
    region: DEFAULT_REGION,
  };

  try {
    const url = `${CONFIGS_API}?app_version=3.1.2&platform=win32-x64`;
    const resp = await fetch(url);
    const json = (await resp.json()) as {
      data?: { configs?: { captcha?: Partial<CaptchaConfig> } };
    };
    const cap = json?.data?.configs?.captcha;
    const cfg: CaptchaConfig = {
      enabled: cap?.enabled !== false,
      prefix: String(cap?.prefix || DEFAULT_PREFIX),
      sceneId: String(cap?.sceneId || DEFAULT_SCENE),
      region: String(cap?.region || DEFAULT_REGION),
    };
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60_000 };
    return cfg;
  } catch {
    cachedConfig = { value: defaults, expiresAt: Date.now() + 60_000 };
    return defaults;
  }
}

/** Proactive traceless solve — attach verifyParam before the chat request. */
export async function getProactiveCaptchaHeaders(): Promise<Record<string, string>> {
  const cfg = await fetchCaptchaConfig();
  const verifyParam = await solveCaptchaJsdom(cfg);
  return {
    [CAPTCHA_HEADER]: verifyParam,
    [REGION_HEADER]: cfg.region,
  };
}

/**
 * Solve captcha after a challenge header (legacy reactive path).
 * Uses the same jsdom traceless solver.
 */
export async function solveCaptcha(_challenge: string): Promise<{ verifyParam: string; region: string }> {
  invalidateJsdomCaptcha();
  const cfg = await fetchCaptchaConfig();
  const verifyParam = await solveCaptchaJsdom(cfg);
  return { verifyParam, region: cfg.region };
}

export { invalidateJsdomCaptcha };
