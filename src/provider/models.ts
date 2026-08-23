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

const TEXT = ["text"] as const;
const VISION = ["text", "image"] as const;

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
  { id: "glm-4.5-air", name: "GLM 4.5 Air", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, inputModalities: TEXT },
  { id: "glm-4.6", name: "GLM 4.6", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, inputModalities: TEXT },
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 200_000, maxOutputTokens: 128_000, inputModalities: VISION },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, forcedReasoning: true, inputModalities: TEXT },
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, inputModalities: TEXT },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, inputModalities: TEXT },
  { id: "glm-5v-turbo", name: "GLM 5V Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, inputModalities: VISION },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true, inputModalities: TEXT },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    reasoning: true,
    reasoningEfforts: ["none", "high", "max"],
    defaultReasoningEffort: "max",
    reasoningEffortMap: { none: "none", minimal: "none", light: "high", low: "high", medium: "high", high: "high", xhigh: "max", max: "max", ultra: "max" },
    inputModalities: TEXT,
  },
  {
    id: "glm-5.3",
    name: "GLM 5.3",
    contextWindow: 200_000,
    maxOutputTokens: 131_072,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
    reasoningEffortMap: { none: "low", minimal: "low", light: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max", ultra: "max" },
    forcedReasoning: true,
    inputModalities: TEXT,
  },
];
