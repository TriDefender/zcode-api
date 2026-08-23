import { MODELS } from "../provider/models.js";
import type { CanonicalReasoningEffort, ModelDef, ModelReasoningEffort } from "../provider/types.js";
import type { AnthropicMessagesRequest } from "./types.js";

/** Catalog aliases like `glm-5.3[1m]` are listing-only; upstream modelCode is the base id. */
export function upstreamModelId(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

/** Official Coding Plan 1M window is opt-in via a trailing `[1m]` alias. */
export const CONTEXT_WINDOW_1M = 1_048_576;

export function catalogContextWindow(modelId: string, definition: ModelDef): number {
  return /\[1m\]$/.test(modelId) ? CONTEXT_WINDOW_1M : definition.contextWindow;
}

export function reasoningModel(model: string): ModelDef | undefined {
  return MODELS.find((entry) => entry.id === upstreamModelId(model));
}

export function normalizeReasoningEffort(
  model: string,
  effort: ModelReasoningEffort | undefined,
): CanonicalReasoningEffort | undefined {
  const definition = reasoningModel(model);
  if (!definition?.reasoningEffortMap || !effort) return undefined;
  if (Object.hasOwn(definition.reasoningEffortMap, effort)) {
    return definition.reasoningEffortMap[effort];
  }
  console.warn(`[reasoning] unknown effort ${JSON.stringify(effort)} for ${definition.id}; using ${definition.defaultReasoningEffort}`);
  return definition.defaultReasoningEffort;
}

export function isForcedReasoning(model: string): boolean {
  return reasoningModel(model)?.forcedReasoning === true;
}

export function isThinkingDisabled(type: unknown): boolean {
  return type === false || type === "disabled" || type === "none" || type === "off";
}

export function normalizeAnthropicReasoning(req: AnthropicMessagesRequest): AnthropicMessagesRequest {
  const effort = normalizeReasoningEffort(req.model, req.output_config?.effort);
  if (effort === "none") {
    const outputConfig = { ...req.output_config };
    delete outputConfig.effort;
    return {
      ...req,
      thinking: { type: "disabled" },
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : { output_config: undefined }),
    };
  }
  if (effort) {
    return { ...req, thinking: { type: "enabled" }, output_config: { ...req.output_config, effort } };
  }
  if (isThinkingDisabled(req.thinking?.type)) {
    if (isForcedReasoning(req.model)) {
      return { ...req, thinking: { type: "enabled" }, output_config: { ...req.output_config, effort: "low" } };
    }
    return req.thinking?.type === "disabled" ? req : { ...req, thinking: { type: "disabled" } };
  }
  return req;
}
