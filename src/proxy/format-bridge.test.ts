import { describe, expect, it } from "bun:test";
import { bridgeAnthropicResponse, bridgeOpenAIRequest } from "./format-bridge.js";

describe("bridgeOpenAIRequest", () => {
  it("passes through anthropic clients unchanged", () => {
    const body = JSON.stringify({ model: "glm-5.2", max_tokens: 16, messages: [] });
    const out = bridgeOpenAIRequest(body, "anthropic", "start-plan");
    expect(out.body).toBe(body);
    expect(out.upstreamFormat).toBe("anthropic");
    expect(out.translateResponse).toBe(false);
  });

  it("translates openai to anthropic on start-plan", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });
    const out = bridgeOpenAIRequest(body, "openai", "start-plan");
    expect(out.upstreamFormat).toBe("anthropic");
    expect(out.translateResponse).toBe(true);
    const parsed = JSON.parse(out.body!);
    expect(parsed.model).toBe("glm-5.2");
    expect(parsed.max_tokens).toBeGreaterThan(0);
    expect(parsed.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(parsed.stream).toBe(true);
  });

  it("does not translate openai on coding-plan", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    const out = bridgeOpenAIRequest(body, "openai", "coding-plan");
    expect(out.body).toBe(body);
    expect(out.upstreamFormat).toBe("openai");
    expect(out.translateResponse).toBe(false);
  });
});

describe("bridgeAnthropicResponse", () => {
  it("translates anthropic JSON to openai chat completion", async () => {
    const upstream = new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "GLM-5.2",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    const resp = await bridgeAnthropicResponse(upstream, "glm-5.2");
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.choices[0].finish_reason).toBe("stop");
  });
});
