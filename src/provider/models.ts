/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier. This replaces the previous `_reverse/models_catalog.json` import,
 * removing that runtime dependency. Update this list when new GLM models are
 * released or specs change.
 *
 * @see .omo/plans/zcode-proxy.md Task 3
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
  { id: "glm-4.5-air", name: "GLM 4.5 Air", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-4.6", name: "GLM 4.6", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 200_000, maxOutputTokens: 128_000, inputModalities: ["text", "image"] },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-4.7-flash", name: "GLM 4.7 Flash", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5v-turbo", name: "GLM 5V Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, inputModalities: ["text", "image"] },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.3", name: "GLM 5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    reasoning: true,
    inputModalities: ["text", "image", "video"],
    thinkingRequired: true,
  },
];

/** Look up a catalog entry by its exact upstream model id. */
export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((model) => model.id === id);
}

/** Whether a catalog model supports reasoning/thinking. */
export function isReasoningModel(id: string): boolean {
  return getModel(id)?.reasoning === true;
}

/** Whether a catalog model requires thinking to stay enabled. */
export function isThinkingRequired(id: string): boolean {
  return getModel(id)?.thinkingRequired === true;
}

/** Whether a catalog model accepts image input. */
export function supportsImageInput(id: string): boolean {
  return getModel(id)?.inputModalities?.includes("image") === true;
}
