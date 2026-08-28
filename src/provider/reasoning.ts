/**
 * GLM-5.3 family reasoning-effort contract.
 *
 * The Anthropic upstream ignores the OpenAI `reasoning_effort` field entirely
 * for this model family — `output_config.effort` is the only channel that
 * actually changes how much the model thinks, and it must be paired with a
 * matching `thinking.budget_tokens` (the effort label alone still produces
 * near-zero thinking). Values below come from ZCode's own model catalog
 * entry for `glm-5.3` (`defaultLevel: "max"`, three effort levels each
 * setting both fields) plus live upstream verification.
 */

/** The three legal `output_config.effort` levels for GLM-5.3 models. */
export const GLM53_EFFORT_LEVELS = ["low", "high", "max"] as const;

/** One of the three legal GLM-5.3 effort levels. */
export type Glm53Effort = (typeof GLM53_EFFORT_LEVELS)[number];

/** ZCode catalog's `defaultLevel` for glm-5.3 — used when no effort is requested. */
export const GLM53_DEFAULT_EFFORT: Glm53Effort = "max";

/**
 * Thinking token budgets ZCode's catalog pairs with each effort level.
 * Sending `output_config.effort` without a matching `thinking.budget_tokens`
 * leaves the upstream at its own near-zero default.
 */
export const GLM53_THINKING_BUDGETS: Readonly<Record<Glm53Effort, number>> = {
  low: 8_000,
  high: 16_000,
  max: 32_000,
};

/**
 * Floor below which a thinking budget stops being useful — measured live
 * against the upstream (a budget this small collapses back to near-zero
 * thinking output).
 */
export const GLM53_MIN_THINKING_BUDGET = 1_024;

/**
 * Tokens reserved for the actual answer once the thinking budget is
 * subtracted from `max_tokens` — see `fitGlm53Budget`. ZCode's own clamp
 * (`Math.min(budgetTokens, maxOutputTokens - 1)`) is written against the
 * *model's* maxOutputTokens ceiling, a large fixed number (128,000 for
 * glm-5.3) where reserving a single token for the answer is harmless.
 * Applying that same "-1" literally against a small per-request
 * `max_tokens` is not — it leaves the response with essentially nothing to
 * work with. 1,024 tokens (matching `GLM53_MIN_THINKING_BUDGET`'s own
 * granularity) is a defensible floor: enough for a short but real answer,
 * without meaningfully eating into a large thinking budget when
 * `max_tokens` is generous.
 */
export const GLM53_ANSWER_RESERVE = 1_024;

/**
 * Match the GLM-5.3 model family, including `glm-5.3-flash`, case-insensitively
 * (the upstream also accepts `GLM-5.3`). Deliberately excludes `glm-5`,
 * `glm-5.1`, and `glm-5.2` — the negative lookahead rejects a trailing digit
 * so `glm-5.30` (were it ever added) would not falsely match either.
 */
const GLM53_MODEL_PATTERN = /glm-5\.3(?![0-9])/i;

/** True when `model` belongs to the GLM-5.3 family (`glm-5.3`, `glm-5.3-flash`, ...). */
export function isGlm53Model(model: string | undefined): boolean {
  if (!model) return false;
  return GLM53_MODEL_PATTERN.test(model);
}

/**
 * Map an OpenAI `reasoning_effort` value onto the three GLM-5.3 effort
 * levels, per Z.AI's official mapping table. Unrecognized or absent values
 * fall back to the catalog default (`max`) rather than the OpenAI-side
 * default (`medium`), since ZCode's own `defaultLevel` for this family is
 * `max`. The mapping rounds UP, not to nearest — `medium` maps to `high`,
 * not `low`.
 */
export function normalizeGlm53Effort(effort: string | undefined): Glm53Effort {
  switch (effort) {
    case "none":
    case "minimal":
    case "light":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
    case "ultra":
      return "max";
    default:
      return GLM53_DEFAULT_EFFORT;
  }
}

/** Build the paired `thinking` + `output_config` fields for a GLM-5.3 effort level. */
export function buildGlm53Reasoning(effort: Glm53Effort): {
  thinking: { type: "enabled"; budget_tokens: number };
  output_config: { effort: Glm53Effort };
} {
  return {
    thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS[effort] },
    output_config: { effort },
  };
}

/**
 * Clamp a thinking budget to fit inside `max_tokens`, reserving
 * `GLM53_ANSWER_RESERVE` tokens for the answer — ZCode's catalog spends the
 * thinking budget out of the same token pool as the response, so a budget
 * that eats the whole of `max_tokens` (or all but one token of it) would
 * leave no meaningful room for output. Returns `undefined` when the clamped
 * budget falls below `GLM53_MIN_THINKING_BUDGET` (the caller should then
 * fall back to `{type:"enabled"}` with no explicit budget). Passes `budget`
 * through unchanged when `maxTokens` isn't a finite number — the upstream
 * doesn't validate this either, so there is nothing useful to clamp against.
 */
export function fitGlm53Budget(budget: number, maxTokens: unknown): number | undefined {
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens)) return budget;
  // Floor first: JSON permits a fractional `max_tokens`, and a fractional
  // `budget_tokens` is not a value the upstream should ever be handed.
  const clamped = Math.min(budget, Math.floor(maxTokens) - GLM53_ANSWER_RESERVE);
  return clamped >= GLM53_MIN_THINKING_BUDGET ? clamped : undefined;
}
