/**
 * Z.AI and Bigmodel provider definitions.
 * @see .omo/plans/zcode-proxy.md Task 3
 * @see _reverse/NOTEPAD.md "Provider Endpoints"
 */
import type { ProviderDef, ProviderId } from "./types.js";

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

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  zai: ZAI_PROVIDER,
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
