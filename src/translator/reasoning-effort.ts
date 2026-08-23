import { MODELS } from "../provider/models.js";
import type { CanonicalReasoningEffort, ModelDef, ModelReasoningEffort } from "../provider/types.js";
import type { AnthropicMessagesRequest } from "./types.js";

export function reasoningModel(model: string): ModelDef | undefined {
  const baseModel = model.replace(/\[1m\]$/, "");
  return MODELS.find((entry) => entry.id === baseModel);
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
