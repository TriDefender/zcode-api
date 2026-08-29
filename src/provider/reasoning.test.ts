/**
 * Tests for the GLM-5.3 reasoning-effort contract.
 * @see src/provider/reasoning.ts
 */
import { describe, it, expect } from "bun:test";
import {
  isGlm53Model,
  normalizeGlm53Effort,
  buildGlm53Reasoning,
  fitGlm53Budget,
  GLM53_DEFAULT_EFFORT,
  GLM53_THINKING_BUDGETS,
  GLM53_MIN_THINKING_BUDGET,
  GLM53_ANSWER_RESERVE,
} from "./reasoning.js";

describe("isGlm53Model", () => {
  it("matches glm-5.3", () => {
    expect(isGlm53Model("glm-5.3")).toBe(true);
  });

  it("matches GLM-5.3 case-insensitively", () => {
    expect(isGlm53Model("GLM-5.3")).toBe(true);
  });

  it("matches glm-5.3-flash", () => {
    expect(isGlm53Model("glm-5.3-flash")).toBe(true);
  });

  it("does not match glm-5.2", () => {
    expect(isGlm53Model("glm-5.2")).toBe(false);
  });

  it("does not match glm-5.1", () => {
    expect(isGlm53Model("glm-5.1")).toBe(false);
  });

  it("does not match glm-5", () => {
    expect(isGlm53Model("glm-5")).toBe(false);
  });

  it("does not match glm-4.7", () => {
    expect(isGlm53Model("glm-4.7")).toBe(false);
  });

  it("does not match undefined", () => {
    expect(isGlm53Model(undefined)).toBe(false);
  });
});

describe("normalizeGlm53Effort", () => {
  it("maps 'none' to 'low'", () => {
    expect(normalizeGlm53Effort("none")).toBe("low");
  });

  it("maps 'minimal' to 'low'", () => {
    expect(normalizeGlm53Effort("minimal")).toBe("low");
  });

  it("maps 'light' to 'low'", () => {
    expect(normalizeGlm53Effort("light")).toBe("low");
  });

  it("maps 'low' to 'low'", () => {
    expect(normalizeGlm53Effort("low")).toBe("low");
  });

  it("rounds 'medium' UP to 'high', not down to 'low' (regression: got this wrong once)", () => {
    expect(normalizeGlm53Effort("medium")).toBe("high");
  });

  it("maps 'high' to 'high'", () => {
    expect(normalizeGlm53Effort("high")).toBe("high");
  });

  it("maps 'xhigh' to 'max'", () => {
    expect(normalizeGlm53Effort("xhigh")).toBe("max");
  });

  it("maps 'max' to 'max'", () => {
    expect(normalizeGlm53Effort("max")).toBe("max");
  });

  it("maps 'ultra' to 'max'", () => {
    expect(normalizeGlm53Effort("ultra")).toBe("max");
  });

  it("defaults unrecognized values to the catalog default (max)", () => {
    expect(normalizeGlm53Effort("bogus")).toBe(GLM53_DEFAULT_EFFORT);
  });

  it("defaults absent value to the catalog default (max)", () => {
    expect(normalizeGlm53Effort(undefined)).toBe(GLM53_DEFAULT_EFFORT);
  });
});

describe("buildGlm53Reasoning", () => {
  it("pairs low effort with its catalog budget", () => {
    expect(buildGlm53Reasoning("low")).toEqual({
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.low },
      output_config: { effort: "low" },
    });
  });

  it("pairs high effort with its catalog budget", () => {
    expect(buildGlm53Reasoning("high")).toEqual({
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.high },
      output_config: { effort: "high" },
    });
  });

  it("pairs max effort with its catalog budget", () => {
    expect(buildGlm53Reasoning("max")).toEqual({
      thinking: { type: "enabled", budget_tokens: GLM53_THINKING_BUDGETS.max },
      output_config: { effort: "max" },
    });
  });
});

describe("fitGlm53Budget", () => {
  it("clamps the budget to max_tokens minus the answer reserve, not max_tokens - 1", () => {
    // Regression: an earlier version clamped to `maxTokens - 1`, which left
    // only a single token for the answer whenever max_tokens was small.
    expect(fitGlm53Budget(32_000, 20_000)).toBe(20_000 - GLM53_ANSWER_RESERVE);
  });

  it("passes the budget through unchanged when it already fits with room to spare", () => {
    expect(fitGlm53Budget(8_000, 128_000)).toBe(8_000);
  });

  it("returns undefined when the clamped budget falls below the 1024 floor", () => {
    expect(fitGlm53Budget(8_000, 1_000)).toBeUndefined();
  });

  it("returns exactly the floor budget unclamped when max_tokens leaves just enough room for floor + answer reserve", () => {
    const maxTokens = GLM53_MIN_THINKING_BUDGET + GLM53_ANSWER_RESERVE;
    expect(fitGlm53Budget(8_000, maxTokens)).toBe(GLM53_MIN_THINKING_BUDGET);
  });

  it("passes the budget through unchanged when maxTokens is not a finite number", () => {
    expect(fitGlm53Budget(32_000, undefined)).toBe(32_000);
    expect(fitGlm53Budget(32_000, Number.NaN)).toBe(32_000);
    expect(fitGlm53Budget(32_000, "128000")).toBe(32_000);
  });

  it("regression: a small explicit max_tokens (e.g. the old generic 4096 default) no longer collapses the thinking budget to a single token, leaving GLM53_ANSWER_RESERVE for the answer", () => {
    // Before this fix, fitGlm53Budget(32_000, 4096) returned 4095 — nearly
    // the entire response allowance spent on thinking, leaving 1 token for
    // the answer. It must now leave at least GLM53_ANSWER_RESERVE tokens.
    const result = fitGlm53Budget(32_000, 4096);
    expect(result).toBe(4096 - GLM53_ANSWER_RESERVE);
    expect(4096 - (result ?? 0)).toBeGreaterThanOrEqual(GLM53_ANSWER_RESERVE);
  });

  it("client omits max_tokens on glm-5.3: given the model's real maxOutputTokens ceiling (128,000, not the generic 4096 fallback), the full effort-level budget survives untouched", () => {
    // This is the scenario resolveDefaultMaxTokens() in openai-to-anthropic.ts
    // exists for: when max_tokens is omitted, glm-5.3 now defaults to its
    // catalog maxOutputTokens (128,000) instead of the generic 4096, so even
    // the largest effort budget (max: 32,000) has ample room to survive the
    // clamp in fitGlm53Budget unchanged.
    expect(fitGlm53Budget(GLM53_THINKING_BUDGETS.max, 128_000)).toBe(GLM53_THINKING_BUDGETS.max);
  });
});
