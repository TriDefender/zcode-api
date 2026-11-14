/**
 * Provider and model type definitions.
 */

/**
 * Supported provider identifiers.
 *
 * `zai_cn` is the desktop 3.18.0+ "Z.ai (CN)" login flavor (host bundle
 * `createZaiCnProviderRuntimeConfig`): it walks the zai OAuth/token chain with
 * a China-region authorize host (zchat.z.ai, server-issued via cli/init) and
 * folds into the zai family everywhere downstream — the config surface
 * (`ProxyConfig.provider`) stays `"zai" | "bigmodel"`, mirroring the official
 * `families: ["zai","bigmodel"]` folding. See NOTEPAD「2026-11-14 增补」.
 */
export type ProviderId = "zai" | "zai_cn" | "bigmodel";

/** Providers selectable in config.yaml / setConfig (config surface, zai_cn folded into bigmodel). */
export type ConfigProviderId = Exclude<ProviderId, "zai_cn">;

/**
 * OAuth LOGIN methods. The bigmodel flavor is config/credential family only —
 * its OAuth login (bigmodel.cn auth-code + poll) is deprecated (superseded by
 * the zai_cn "Z.ai (CN)" zchat login, decision 2026-11-14); legacy bigmodel
 * credentials remain valid and resolve through the shared bigmodel chain.
 */
export type LoginProviderId = Exclude<ProviderId, "bigmodel">;

/** Static provider definition with endpoint URLs. */
export interface ProviderDef {
  id: ProviderId;
  displayName: string;
  /** Base URL for Anthropic-format requests (no trailing slash). */
  anthropicBaseURL: string;
  /** Base URL for OpenAI-format requests (no trailing slash). */
  openaiBaseURL: string;
  /** Host for OAuth/API-key resolution business APIs. */
  bizHost: string;
}

/** Model definition derived from the catalog. */
export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Whether the model supports reasoning/thinking mode. */
  reasoning?: boolean;
  /** Whether the model accepts image input (explicit — no id-shape heuristic). */
  vision?: boolean;
}
