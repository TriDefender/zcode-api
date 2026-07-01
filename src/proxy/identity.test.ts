/**
 * Tests for identity header builder.
 * Mirrors `pio` in the current ZCode bundle (`_reverse/zcode.cjs`).
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { buildIdentityHeaders } from "./identity.js";
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
    const h = buildIdentityHeaders(BASE);
    // Mirrors the bundle: identity headers, then runtime platform headers from `SOr()`.
    expect(Object.keys(h)).toEqual([
      "HTTP-Referer",
      "User-Agent",
      "X-ZCode-App-Version",
      "X-Title",
      "X-ZCode-Agent",
      "X-Platform",
      "X-Os-Category",
      "X-Os-Version",
    ]);
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
