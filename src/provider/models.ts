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
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 200_000, maxOutputTokens: 128_000 },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5v-turbo", name: "GLM 5V Turbo", contextWindow: 200_000, maxOutputTokens: 128_000 },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
];
