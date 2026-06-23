/**
 * Tests for the exported `parseServeArgs` pure function.
 */
import { describe, it, expect } from "bun:test";
import { parseServeArgs } from "./index.js";

describe("parseServeArgs", () => {
  it("returns debug=false with no args", () => {
    expect(parseServeArgs([])).toEqual({ configPath: undefined, debug: false });
  });

  it("returns debug=true with lone 'debug' token", () => {
    expect(parseServeArgs(["debug"])).toEqual({ configPath: undefined, debug: true });
  });

  it("treats a single non-debug token as the config path", () => {
    expect(parseServeArgs(["my.yaml"])).toEqual({ configPath: "my.yaml", debug: false });
  });

  it("accepts 'debug' before the config path", () => {
    expect(parseServeArgs(["debug", "custom.yaml"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("accepts 'debug' after the config path (order-independent)", () => {
    expect(parseServeArgs(["custom.yaml", "debug"])).toEqual({
      configPath: "custom.yaml",
      debug: true,
    });
  });

  it("is case-sensitive — only lowercase 'debug' toggles the flag", () => {
    expect(parseServeArgs(["DEBUG"])).toEqual({ configPath: "DEBUG", debug: false });
  });
});
