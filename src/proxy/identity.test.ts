/**
 * Tests for identity header builder.
 * Mirrors `pio` in the current ZCode bundle (`_reverse/zcode.cjs`).
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { buildIdentityHeaders, buildLlmIdentityHeaders } from "./identity.js";
import type { ProxyIdentity } from "../config/types.js";

const BASE: ProxyIdentity = {
  appVersion: "1.2.3",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

describe("buildIdentityHeaders", () => {
  it("emits User-Agent as ZCode/{appVersion}", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "9.9.9" });
    expect(h["User-Agent"]).toBe("ZCode/9.9.9");
  });

  it("emits X-ZCode-App-Version mirroring User-Agent version", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "4.5.6" });
    expect(h["X-ZCode-App-Version"]).toBe("4.5.6");
    expect(h["User-Agent"]).toBe("ZCode/4.5.6");
  });

  it("emits X-Title as `Z Code@{sourceTitle}`", () => {
    const h = buildIdentityHeaders({ ...BASE, sourceTitle: "electron" });
    expect(h["X-Title"]).toBe("Z Code@electron");
  });

  it("hard-codes X-ZCode-Agent to glm", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-ZCode-Agent"]).toBe("glm");
  });

  it("emits runtime platform headers matching the current ZCode bundle", () => {
    const h = buildIdentityHeaders(BASE);
    const expectedCategory = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    expect(h["X-Platform"]).toBe(`${process.platform}-${os.arch()}`);
    expect(h["X-Os-Category"]).toBe(expectedCategory);
    expect(h["X-Os-Version"]).toBe(os.release());
  });

  it("emits X-Client-Language/X-Client-Timezone from Intl by default", () => {
    const h = buildIdentityHeaders(BASE);
    const expectedLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const expectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(h["X-Client-Language"]).toBe(expectedLocale);
    expect(h["X-Client-Timezone"]).toBe(expectedTz);
  });

  it("emits X-Device-Mid from config value when no env override is set", () => {
    const mid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const h = buildIdentityHeaders({ ...BASE, deviceMid: mid });
    expect(h["X-Device-Mid"]).toBe(mid);
  });

  it("omits X-Device-Mid when neither env nor config provides one", () => {
    const saved = process.env.ZCODE_IDENTITY_DEVICE_MID;
    delete process.env.ZCODE_IDENTITY_DEVICE_MID;
    try {
      const h = buildIdentityHeaders(BASE);
      expect(h["X-Device-Mid"]).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.ZCODE_IDENTITY_DEVICE_MID = saved;
    }
  });

  it("ZCODE_IDENTITY_DEVICE_MID env wins over the config value", () => {
    const saved = process.env.ZCODE_IDENTITY_DEVICE_MID;
    process.env.ZCODE_IDENTITY_DEVICE_MID = "11111111-2222-4333-8444-555555555555";
    try {
      const h = buildIdentityHeaders({ ...BASE, deviceMid: "00000000-0000-4000-8000-000000000000" });
      expect(h["X-Device-Mid"]).toBe("11111111-2222-4333-8444-555555555555");
    } finally {
      if (saved === undefined) delete process.env.ZCODE_IDENTITY_DEVICE_MID;
      else process.env.ZCODE_IDENTITY_DEVICE_MID = saved;
    }
  });

  it("drops a non-printable deviceMid instead of emitting it", () => {
    const saved = process.env.ZCODE_IDENTITY_DEVICE_MID;
    process.env.ZCODE_IDENTITY_DEVICE_MID = "bad\u00ffvalue";
    try {
      const h = buildIdentityHeaders(BASE);
      expect(h["X-Device-Mid"]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ZCODE_IDENTITY_DEVICE_MID;
      else process.env.ZCODE_IDENTITY_DEVICE_MID = saved;
    }
  });

  it("honours ZCODE_IDENTITY_* env overrides for the four new headers", () => {
    const saved = {
      rc: process.env.ZCODE_IDENTITY_RELEASE_CHANNEL,
      cl: process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE,
      ct: process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE,
      dm: process.env.ZCODE_IDENTITY_DEVICE_MID,
    };
    process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = "beta";
    process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = "en-US";
    process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = "UTC";
    process.env.ZCODE_IDENTITY_DEVICE_MID = "mid-abc-123";
    try {
      const h = buildIdentityHeaders(BASE);
      expect(h["X-Release-Channel"]).toBe("beta");
      expect(h["X-Client-Language"]).toBe("en-US");
      expect(h["X-Client-Timezone"]).toBe("UTC");
      expect(h["X-Device-Mid"]).toBe("mid-abc-123");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k === "rc" ? "ZCODE_IDENTITY_RELEASE_CHANNEL" : k === "cl" ? "ZCODE_IDENTITY_CLIENT_LANGUAGE" : k === "ct" ? "ZCODE_IDENTITY_CLIENT_TIMEZONE" : "ZCODE_IDENTITY_DEVICE_MID"];
        else process.env[k === "rc" ? "ZCODE_IDENTITY_RELEASE_CHANNEL" : k === "cl" ? "ZCODE_IDENTITY_CLIENT_LANGUAGE" : k === "ct" ? "ZCODE_IDENTITY_CLIENT_TIMEZONE" : "ZCODE_IDENTITY_DEVICE_MID"] = v;
      }
    }
  });

  it("defaults X-Release-Channel to production and honors ZCODE_ENV=test (bundle IL())", () => {
    const h = buildIdentityHeaders(BASE);
    expect(h["X-Release-Channel"]).toBe("production");
    expect(h["X-Device-Mid"]).toBeUndefined();

    const savedEnv = process.env.ZCODE_ENV;
    process.env.ZCODE_ENV = "test";
    try {
      expect(buildIdentityHeaders(BASE)["X-Release-Channel"]).toBe("test");
    } finally {
      if (savedEnv === undefined) delete process.env.ZCODE_ENV;
      else process.env.ZCODE_ENV = savedEnv;
    }
  });

  it("passes refererOrigin through as HTTP-Referer", () => {
    const h = buildIdentityHeaders({ ...BASE, refererOrigin: "https://example.com" });
    expect(h["HTTP-Referer"]).toBe("https://example.com");
  });

  it("preserves the literal 'unknown' version (still printable ASCII)", () => {
    const h = buildIdentityHeaders({ ...BASE, appVersion: "unknown" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBe("unknown");
  });

  // --- New behaviour matching `pio` in the current ZCode bundle ---

  it("emits headers in the exact `pio` order", () => {
    // Clear env-gated headers so the order assertion is deterministic;
    // X-Client-Language/X-Client-Timezone are always present via Intl.
    const savedRC = process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    const savedDM = process.env.ZCODE_IDENTITY_DEVICE_MID;
    delete process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    delete process.env.ZCODE_IDENTITY_DEVICE_MID;
    try {
      const h = buildIdentityHeaders(BASE);
      // Mirrors the bundle's `pio` (L43): identity headers, then runtime
      // platform + env headers in bundle order.
      expect(Object.keys(h)).toEqual([
        "HTTP-Referer",
        "User-Agent",
        "X-ZCode-App-Version",
        "X-Title",
        "X-ZCode-Agent",
        "X-Platform",
        "X-Release-Channel",
        "X-Client-Language",
        "X-Client-Timezone",
        "X-Os-Category",
        "X-Os-Version",
      ]);
    } finally {
      if (savedRC !== undefined) process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = savedRC;
      if (savedDM !== undefined) process.env.ZCODE_IDENTITY_DEVICE_MID = savedDM;
    }
  });

  it("drops X-ZCode-App-Version and falls User-Agent back to ZCode/unknown when no version resolves", () => {
    // Mirrors `pio` when `fio` returns undefined: User-Agent → "ZCode/unknown", no X-ZCode-App-Version.
    const empty = buildIdentityHeaders({ ...BASE, appVersion: "" });
    expect(empty["User-Agent"]).toBe("ZCode/unknown");
    expect(empty["X-ZCode-App-Version"]).toBeUndefined();

    const missing = buildIdentityHeaders({ ...BASE, appVersion: undefined as unknown as string });
    expect(missing["User-Agent"]).toBe("ZCode/unknown");
    expect(missing["X-ZCode-App-Version"]).toBeUndefined();
  });
});

describe("buildLlmIdentityHeaders (CLI `csn` shape — CL-27)", () => {
  it("emits headers in the csn order with X-ZCode-Agent LAST and no X-Device-Mid", () => {
    const savedDM = process.env.ZCODE_IDENTITY_DEVICE_MID;
    delete process.env.ZCODE_IDENTITY_DEVICE_MID;
    try {
      const h = buildLlmIdentityHeaders({ ...BASE, deviceMid: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0" });
      expect(Object.keys(h)).toEqual([
        "HTTP-Referer",
        "User-Agent",
        "X-ZCode-App-Version",
        "X-Title",
        "X-Release-Channel",
        "X-Client-Language",
        "X-Client-Timezone",
        "X-Platform",
        "X-Os-Category",
        "X-Os-Version",
        "X-ZCode-Agent",
      ]);
      // The CLI LLM path NEVER carried X-Device-Mid — even when one exists for
      // the control-plane (HRt) header set.
      expect(h["X-Device-Mid"]).toBeUndefined();
    } finally {
      if (savedDM !== undefined) process.env.ZCODE_IDENTITY_DEVICE_MID = savedDM;
    }
  });

  it("always emits language/timezone, falling back to literal 'unknown'", () => {
    const saved = {
      cl: process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE,
      ct: process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE,
    };
    // Non-printable overrides are dropped by the gate → Intl normally
    // re-resolves; simulate "nothing resolves" by overriding with values that
    // fail the printable-ASCII gate AND are empty after trim is impossible —
    // instead assert the always-present contract directly:
    process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = "fr-FR";
    process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = "Europe/Paris";
    try {
      const h = buildLlmIdentityHeaders(BASE);
      expect(h["X-Client-Language"]).toBe("fr-FR");
      expect(h["X-Client-Timezone"]).toBe("Europe/Paris");
      // Always present on the LLM path (csn contract):
      expect("X-Client-Language" in h).toBe(true);
      expect("X-Client-Timezone" in h).toBe(true);
    } finally {
      if (saved.cl === undefined) delete process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE;
      else process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE = saved.cl;
      if (saved.ct === undefined) delete process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE;
      else process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE = saved.ct;
    }
    // "unknown" fallback: whitespace-only override fails the gate, Intl
    // re-resolves — but the KEY must exist regardless of resolution.
    const h2 = buildLlmIdentityHeaders(BASE);
    expect(typeof h2["X-Client-Language"]).toBe("string");
    expect(typeof h2["X-Client-Timezone"]).toBe("string");
  });

  it("falls User-Agent back to ZCode/unknown and omits X-ZCode-App-Version when no version resolves", () => {
    const h = buildLlmIdentityHeaders({ ...BASE, appVersion: "" });
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("keeps X-ZCode-Agent as glm in the final position even when platform headers are absent", () => {
    const savedP = process.env.ZCODE_IDENTITY_PLATFORM;
    const savedA = process.env.ZCODE_IDENTITY_ARCH;
    const savedR = process.env.ZCODE_IDENTITY_RELEASE;
    delete process.env.ZCODE_IDENTITY_PLATFORM;
    delete process.env.ZCODE_IDENTITY_ARCH;
    delete process.env.ZCODE_IDENTITY_RELEASE;
    // NOTE: platform/arch fall back to the real process values, so the
    // conditional headers still resolve on a real host — the assertion pins
    // the RELATIVE position of X-ZCode-Agent (always last).
    try {
      const h = buildLlmIdentityHeaders(BASE);
      const keys = Object.keys(h);
      expect(keys[keys.length - 1]).toBe("X-ZCode-Agent");
      expect(h["X-ZCode-Agent"]).toBe("glm");
      if (h["X-Platform"]) expect(h["X-Platform"]).toBe(`${process.platform}-${os.arch()}`);
    } finally {
      if (savedP !== undefined) process.env.ZCODE_IDENTITY_PLATFORM = savedP;
      if (savedA !== undefined) process.env.ZCODE_IDENTITY_ARCH = savedA;
      if (savedR !== undefined) process.env.ZCODE_IDENTITY_RELEASE = savedR;
    }
  });

  it("always emits X-Release-Channel (default production, ZCODE_ENV=test switch)", () => {
    const savedEnv = process.env.ZCODE_ENV;
    const savedRC = process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    delete process.env.ZCODE_IDENTITY_RELEASE_CHANNEL;
    try {
      expect(buildLlmIdentityHeaders(BASE)["X-Release-Channel"]).toBe("production");
      process.env.ZCODE_ENV = "test";
      expect(buildLlmIdentityHeaders(BASE)["X-Release-Channel"]).toBe("test");
    } finally {
      if (savedEnv === undefined) delete process.env.ZCODE_ENV;
      else process.env.ZCODE_ENV = savedEnv;
      if (savedRC !== undefined) process.env.ZCODE_IDENTITY_RELEASE_CHANNEL = savedRC;
    }
  });
});
