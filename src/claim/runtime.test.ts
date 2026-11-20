/**
 * Tests for the claim-plane wiring helpers.
 *
 * `claimDeviceMid` exists because the billing gateway rejects every preview /
 * claim call that arrives without a UUID `X-Device-Mid` (biz 3001 "parameter
 * error", client.ts file header). A config with no `identity.deviceMid` used to
 * reach the claim POST with the header omitted — the observed Android symptom
 * was `[claim] claim: invalid_request (3001) — parameter error`, even though
 * the marketing face could still enumerate the plan via its own fallback.
 */
import { describe, it, expect } from "bun:test";
import { claimDeviceMid } from "./runtime.js";
import type { ProxyConfig } from "../config/types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function configWith(deviceMid?: string): ProxyConfig {
  return {
    identity: {
      appVersion: "3.19.1",
      sourceTitle: "cli",
      refererOrigin: "https://zcode.z.ai",
      ...(deviceMid !== undefined ? { deviceMid } : {}),
    },
  } as ProxyConfig;
}

describe("claimDeviceMid", () => {
  it("uses the configured identity.deviceMid verbatim", () => {
    expect(claimDeviceMid(configWith("0d2c62ae-717c-4d88-9bbe-24c28fd45ed6")))
      .toBe("0d2c62ae-717c-4d88-9bbe-24c28fd45ed6");
  });

  it("treats a blank/whitespace value as unset", () => {
    expect(claimDeviceMid(configWith("   "))).toMatch(UUID_V4);
  });

  it("falls back to a stable UUIDv4 when the config carries none", () => {
    const first = claimDeviceMid(configWith());
    expect(first).toMatch(UUID_V4);
    // Fingerprint stability: upstream risk engines require one device id per
    // install — never randomize per call.
    expect(claimDeviceMid(configWith())).toBe(first);
  });
});
