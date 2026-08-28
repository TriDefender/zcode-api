/**
 * Tests for the Anthropic → OpenAI request translator's `output_config`
 * handling (start-plan direction: Anthropic client → OpenAI upstream).
 * @see src/translator/anthropic-to-openai.ts
 */
import { describe, it, expect } from "bun:test";
import { translateRequestAnthropicToOpenAI } from "./anthropic-to-openai.js";
import type { AnthropicMessagesRequest } from "./types.js";

describe("translateRequestAnthropicToOpenAI: output_config.effort", () => {
  it("carries output_config.effort into reasoning_effort on the OpenAI-format upstream body", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      output_config: { effort: "high" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when output_config is absent", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBeUndefined();
  });

  // `output_config` is a GLM-5.3 family extension. A client that sends it on
  // any other model must not have that model's reasoning silently rerouted
  // through a channel it never opted into.
  it("does not carry output_config.effort over for a non-GLM-5.3 model", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.7",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      output_config: { effort: "high" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort when output_config is present but effort is not set", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      output_config: {},
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBeUndefined();
  });
});
