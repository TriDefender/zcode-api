import { describe, it, expect } from "bun:test";
import { injectOfficialZcodeSystem, ZCODE_SYSTEM_BLOCKS } from "./system-prompt.js";

describe("injectOfficialZcodeSystem", () => {
  it("prepends two official gateway blocks", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "hi" }],
    };
    injectOfficialZcodeSystem(body);
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system).toHaveLength(2);
    expect(system[0].text).toBe(ZCODE_SYSTEM_BLOCKS[0].text);
    expect(system[1].text).toBe(ZCODE_SYSTEM_BLOCKS[1].text);
  });

  it("appends user system blocks after official blocks", () => {
    const body: Record<string, unknown> = {
      system: [{ type: "text", text: "custom rules" }],
      messages: [],
    };
    injectOfficialZcodeSystem(body);
    const system = body.system as Array<{ text: string }>;
    expect(system).toHaveLength(3);
    expect(system[2].text).toBe("custom rules");
  });

  it("handles malformed text block without throwing", () => {
    const body: Record<string, unknown> = {
      system: [{ type: "text", text: 123 }],
      messages: [],
    };
    expect(() => injectOfficialZcodeSystem(body)).not.toThrow();
    const system = body.system as Array<{ text: string }>;
    expect(system).toHaveLength(2);
  });
});
