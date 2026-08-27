/**
 * Tests for provider definitions and model catalog.
 * @see .omo/plans/zcode-proxy.md Task 3
 */
import { describe, it, expect } from "bun:test";
import { getProvider, ZAI_PROVIDER, BIGMODEL_PROVIDER } from "./providers.js";
import { getModel, isReasoningModel, isThinkingRequired, MODELS, supportsImageInput } from "./models.js";

describe("providers", () => {
  it("getProvider returns Z.AI definition", () => {
    const p = getProvider("zai");
    expect(p.id).toBe("zai");
    expect(p.anthropicBaseURL).toBe("https://api.z.ai/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://api.z.ai");
  });

  it("getProvider returns Bigmodel definition", () => {
    const p = getProvider("bigmodel");
    expect(p.id).toBe("bigmodel");
    expect(p.anthropicBaseURL).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://open.bigmodel.cn");
  });

  it("ZAI_PROVIDER constant matches getProvider('zai')", () => {
    expect(ZAI_PROVIDER).toEqual(getProvider("zai"));
  });

  it("BIGMODEL_PROVIDER constant matches getProvider('bigmodel')", () => {
    expect(BIGMODEL_PROVIDER).toEqual(getProvider("bigmodel"));
  });

  it("getProvider throws on unknown id", () => {
    expect(() => getProvider("openai" as any)).toThrow(/Unknown provider/);
  });
});

describe("models", () => {
  it("MODELS contains exactly the 12 pinned coding-plan models", () => {
    expect(MODELS).toHaveLength(12);
    const ids = MODELS.map((m) => m.id);
    expect(ids).toEqual([
      "glm-4.5-air", "glm-4.6", "glm-4.6v", "glm-4.7", "glm-4.7-flash",
      "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
    ]);
  });

  it("all models have valid id and contextWindow", () => {
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBe(m.id === "glm-5.3-flash" ? 131_072 : 128_000);
    }
  });

  it("all models except the 1M-context models have 200k context", () => {
    for (const m of MODELS) {
      if (m.id === "glm-5.2" || m.id === "glm-5.3" || m.id === "glm-5.3-flash") continue;
      expect(m.contextWindow).toBe(200_000);
    }
  });

  it("GLM-5.2, GLM-5.3, and GLM-5.3-Flash have 1M context", () => {
    const glm52 = MODELS.find((m) => m.id === "glm-5.2");
    expect(glm52).toBeDefined();
    expect(glm52!.contextWindow).toBe(1_000_000);
    const glm53 = MODELS.find((m) => m.id === "glm-5.3");
    expect(glm53).toBeDefined();
    expect(glm53!.contextWindow).toBe(1_000_000);
    const glm53Flash = MODELS.find((m) => m.id === "glm-5.3-flash");
    expect(glm53Flash).toBeDefined();
    expect(glm53Flash!.contextWindow).toBe(1_000_000);
  });

  it("records reasoning and multimodal capabilities for the new models", () => {
    expect(getModel("glm-4.7-flash")).toMatchObject({
      reasoning: true,
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
    });
    expect(isReasoningModel("glm-4.7-flash")).toBe(true);
    expect(supportsImageInput("glm-4.7-flash")).toBe(false);

    expect(getModel("glm-5.3-flash")).toMatchObject({
      reasoning: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      inputModalities: ["text", "image", "video"],
      thinkingRequired: true,
    });
    expect(supportsImageInput("glm-5.3-flash")).toBe(true);
    expect(isThinkingRequired("glm-5.3-flash")).toBe(true);
  });

  it("includes key GLM models", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("glm-4.6");
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("glm-5.3");
    expect(ids).toContain("glm-4.7-flash");
    expect(ids).toContain("glm-5.3-flash");
    expect(ids).toContain("glm-5v-turbo");
  });
});
