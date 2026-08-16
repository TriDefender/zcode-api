/**
 * Tests for the exported pure functions (`parseServeArgs`,
 * `applyAndroidIdentityDefaults`).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { parseServeArgs, applyAndroidIdentityDefaults } from "./index.js";
import { buildIdentityHeaders } from "./proxy/identity.js";

const IDENTITY_ENV_KEYS = [
  "ZCODE_IDENTITY_PLATFORM",
  "ZCODE_IDENTITY_ARCH",
  "ZCODE_IDENTITY_RELEASE",
] as const;

const savedEnv: Record<string, string | undefined> = {};

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

describe("applyAndroidIdentityDefaults", () => {
  afterEach(() => {
    for (const k of IDENTITY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
      delete savedEnv[k];
    }
  });

  function snapshotEnv(): void {
    for (const k of IDENTITY_ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
  }

  it("injects a stable desktop-Linux profile when no overrides are set", () => {
    snapshotEnv();
    applyAndroidIdentityDefaults();
    expect(process.env.ZCODE_IDENTITY_PLATFORM).toBe("linux");
    expect(process.env.ZCODE_IDENTITY_ARCH).toBe("x64");
    expect(process.env.ZCODE_IDENTITY_RELEASE).toBe("6.8.0-49-generic");
  });

  it("never clobbers explicit env overrides", () => {
    snapshotEnv();
    process.env.ZCODE_IDENTITY_PLATFORM = "linux";
    process.env.ZCODE_IDENTITY_ARCH = "arm64";
    process.env.ZCODE_IDENTITY_RELEASE = "6.1.0-26-amd64";
    applyAndroidIdentityDefaults();
    expect(process.env.ZCODE_IDENTITY_ARCH).toBe("arm64");
    expect(process.env.ZCODE_IDENTITY_RELEASE).toBe("6.1.0-26-amd64");
  });

  it("produces headers free of any Android telltales", () => {
    snapshotEnv();
    applyAndroidIdentityDefaults();
    const h = buildIdentityHeaders({ appVersion: "3.7.7", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" });
    const blob = JSON.stringify(h).toLowerCase();
    expect(h["X-Platform"]).toBe("linux-x64");
    expect(h["X-Os-Category"]).toBe("linux");
    expect(h["X-Os-Version"]).toBe("6.8.0-49-generic");
    expect(blob).not.toContain("android");
    expect(blob).not.toContain("aarch64");
  });
});
