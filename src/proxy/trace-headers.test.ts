/**
 * Tests for the metadata.user_id builder (bundle `E2e`/`UIo`/`bnt` mirror)
 * and the shared prefix stripper (`jfr`).
 */
import { describe, it, expect } from "bun:test";
import { buildAnthropicMetadataUserId, buildZcodeTraceHeaders, stripHeaderInternalPrefixes } from "./trace-headers.js";

describe("buildAnthropicMetadataUserId (bundle UIo)", () => {
  it("emits the exact JSON blob: device_id, always-empty account_uuid, prefix-stripped session_id", () => {
    expect(buildAnthropicMetadataUserId("mid-123", "sess_abc")).toBe(
      '{"device_id":"mid-123","account_uuid":"","session_id":"abc"}',
    );
  });

  it("strips subagent_agent_ prefixes too (bnt prefix set = NIo/LIo)", () => {
    expect(buildAnthropicMetadataUserId("mid-123", "subagent_agent_xyz")).toBe(
      '{"device_id":"mid-123","account_uuid":"","session_id":"xyz"}',
    );
  });

  it("omits device_id when deviceMid is absent (UIo passes the property through; JSON.stringify drops undefined)", () => {
    expect(buildAnthropicMetadataUserId(undefined, "sess_abc")).toBe(
      '{"account_uuid":"","session_id":"abc"}',
    );
  });

  it("falls back to empty session_id when no session is available (bnt(undefined) → ?? \"\")", () => {
    expect(buildAnthropicMetadataUserId("mid-123", undefined)).toBe(
      '{"device_id":"mid-123","account_uuid":"","session_id":""}',
    );
  });

  it("never carries the account uuid — account_uuid is hardcoded empty in the bundle", () => {
    const out = buildAnthropicMetadataUserId("mid", "sess_s");
    expect(JSON.parse(out).account_uuid).toBe("");
  });
});

describe("stripHeaderInternalPrefixes (bundle jfr)", () => {
  it("returns the original when stripping everything would leave an empty string", () => {
    expect(stripHeaderInternalPrefixes("sess_", ["sess_"])).toBe("sess_");
  });
});

describe("buildZcodeTraceHeaders — session-type derivation (gateway system-shape pairing)", () => {
  it("derives subagent from a subagent_agent_ session id, strips the prefix on the wire x-session-id", () => {
    const h = buildZcodeTraceHeaders({ sessionId: "subagent_agent_656fafe3-1" });
    expect(h["x-zcode-session-type"]).toBe("subagent");
    expect(h["x-session-id"]).toBe("656fafe3-1"); // prefix is internal-only (bundle loo strip)
  });

  it("explicit sessionType wins even without a session id (observe/lineage-fail pairing fallback)", () => {
    const h = buildZcodeTraceHeaders({ sessionType: "subagent" });
    expect(h["x-zcode-session-type"]).toBe("subagent");
    expect(h["x-session-id"]).toBeUndefined();
    // "other" branch of the resolveSessionType whitelist — consolidated here
    // from upstream.test.ts so the pure-function seam owns all its coverage.
    expect(buildZcodeTraceHeaders({ sessionType: "other" })["x-zcode-session-type"]).toBe("other");
  });

  it("explicit sessionType beats a contradicting session-id prefix", () => {
    const h = buildZcodeTraceHeaders({ sessionId: "subagent_agent_x", sessionType: "main" });
    expect(h["x-zcode-session-type"]).toBe("main");
  });

  it("default stays main for unprefixed session ids", () => {
    const h = buildZcodeTraceHeaders({ sessionId: "656fafe3-2" });
    expect(h["x-zcode-session-type"]).toBe("main");
  });
});
