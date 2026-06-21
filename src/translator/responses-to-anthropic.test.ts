import { describe, expect, it } from "bun:test";
import { translateResponsesToAnthropic } from "./responses-to-anthropic.js";

describe("translateResponsesToAnthropic", () => {
  it("converts simple string input to anthropic user message", () => {
    const out = translateResponsesToAnthropic({
      model: "glm-5.2",
      input: "hello",
      stream: true,
    });
    expect(out.model).toBe("glm-5.2");
    expect(out.stream).toBe(true);
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(out.max_tokens).toBe(8192);
  });

  it("merges instructions into system", () => {
    const out = translateResponsesToAnthropic({
      model: "glm-5.2",
      instructions: "Be concise",
      input: [{ role: "user", content: "hi" }],
    });
    expect(out.system).toBe("Be concise");
  });

  it("defaults stream to true when omitted", () => {
    const out = translateResponsesToAnthropic({ model: "glm-5.2", input: "x" });
    expect(out.stream).toBe(true);
  });
});
