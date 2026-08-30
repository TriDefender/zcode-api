/**
 * Tests for credential types and auth manager.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import { describe, it, expect } from "bun:test";
import { credentialString, isExpired } from "./types.js";
import { AuthManager } from "./manager.js";

describe("credentialString", () => {
  it("returns apiKey.secret when secret present", () => {
    expect(credentialString({ apiKey: "a", secret: "b", provider: "zai" })).toBe("a.b");
  });

  it("returns apiKey only when secret absent", () => {
    expect(credentialString({ apiKey: "abc", provider: "bigmodel" })).toBe("abc");
  });

  it("handles complex key values", () => {
    expect(credentialString({ apiKey: "key123", secret: "secret456", provider: "zai" })).toBe(
      "key123.secret456",
    );
  });
});

describe("isExpired", () => {
  it("returns false when expiresAt is undefined", () => {
    expect(isExpired({ apiKey: "x", provider: "zai" })).toBe(false);
  });

  it("returns true when past expiry", () => {
    const cred = { apiKey: "x", provider: "zai" as const, expiresAt: 1000 };
    expect(isExpired(cred, 2000)).toBe(true);
  });

  it("returns false when before expiry", () => {
    const cred = { apiKey: "x", provider: "zai" as const, expiresAt: 3000 };
    expect(isExpired(cred, 2000)).toBe(false);
  });
});

describe("AuthManager", () => {
  it("throws without a credential", async () => {
    const mgr = new AuthManager();
    expect(mgr.getCredential()).rejects.toThrow(/not available/);
  });

  it("returns the credential set via setOAuthCredential", async () => {
    const mgr = new AuthManager();
    mgr.setOAuthCredential({ apiKey: "oa", secret: "sc", provider: "zai" });
    const cred = await mgr.getCredential();
    expect(cred.apiKey).toBe("oa");
    expect(cred.secret).toBe("sc");
  });

  it("returns the latest credential after re-set", async () => {
    const mgr = new AuthManager();
    mgr.setOAuthCredential({ apiKey: "old", provider: "zai" });
    mgr.setOAuthCredential({ apiKey: "new", provider: "zai" });
    const cred = await mgr.getCredential();
    expect(cred.apiKey).toBe("new");
  });

  it("throws on an expired credential and clears it", async () => {
    const mgr = new AuthManager();
    mgr.setOAuthCredential({ apiKey: "x", provider: "zai", expiresAt: 1000 });
    await expect(mgr.getCredential()).rejects.toThrow(/expired/);
    await expect(mgr.getCredential()).rejects.toThrow(/not available/);
  });
});
