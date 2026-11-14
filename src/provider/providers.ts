/**
 * Z.AI and Bigmodel provider definitions.
 * @see _reverse/NOTEPAD.md "Provider Endpoints"
 */
import type { ConfigProviderId, ProviderDef, ProviderId } from "./types.js";

export const ZAI_PROVIDER: ProviderDef = {
  id: "zai",
  displayName: "Z.AI",
  anthropicBaseURL: "https://api.z.ai/api/anthropic",
  openaiBaseURL: "https://api.z.ai/api/coding/paas/v4",
  bizHost: "https://api.z.ai",
};

export const BIGMODEL_PROVIDER: ProviderDef = {
  id: "bigmodel",
  displayName: "BigModel / 智谱",
  anthropicBaseURL: "https://open.bigmodel.cn/api/anthropic",
  openaiBaseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
  bizHost: "https://open.bigmodel.cn",
};

/**
 * Z.ai China-region login flavor (desktop 3.18.2 host `createZaiCnProviderRuntimeConfig`:
 * `{...TF(zai配置), id:zai_cn, displayName:"Z.ai (CN)"}`). The LOGIN face rides the
 * zai OAuth chain (zchat.z.ai authorize host issued server-side via cli/init,
 * `/cli/callback/zai_cn` callback) — but the DOWNSTREAM family is BIGMODEL:
 * `resolveStartPlanFamilyFromOAuthProvider` maps zai_cn → "bigmodel" and a
 * zai_cn login surfaces the user's BigModel subscription (live-verified
 * 2026-11-14). The polled token is used AS-IS (no z/login) against the
 * bigmodel.cn biz chain, so the endpoints here mirror BIGMODEL_PROVIDER.
 */
export const ZAI_CN_PROVIDER: ProviderDef = {
  id: "zai_cn",
  displayName: "Z.AI (CN)",
  anthropicBaseURL: BIGMODEL_PROVIDER.anthropicBaseURL,
  openaiBaseURL: BIGMODEL_PROVIDER.openaiBaseURL,
  bizHost: BIGMODEL_PROVIDER.bizHost,
};

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  zai: ZAI_PROVIDER,
  zai_cn: ZAI_CN_PROVIDER,
  bigmodel: BIGMODEL_PROVIDER,
};

/** Look up a provider definition by id. */
export function getProvider(id: ProviderId): ProviderDef {
  const def = PROVIDERS[id];
  if (!def) {
    throw new Error(`Unknown provider: "${id}"`);
  }
  return def;
}

/**
 * Credential → config-surface family. The mirror of the desktop's
 * `resolveStartPlanFamilyFromOAuthProvider` (3.18.2 main chunk, original name
 * pinned): **`zai_cn` folds into the BIGMODEL family** — a China-region Z.ai
 * login resolves to the user's BigModel/智谱 subscription (live-verified
 * 2026-11-14: a zai_cn login surfaces the user's bigmodel plan). Only the
 * login face rides the zai OAuth chain; everything downstream (biz host,
 * API-key resolution, signing, highspeed family) is the bigmodel one.
 */
export function credentialFamily(provider: ProviderId): ConfigProviderId {
  return provider === "zai" ? "zai" : "bigmodel";
}
