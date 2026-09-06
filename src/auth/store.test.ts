/**
 * Tests for encrypted credential store.
 * @see .omo/plans/zcode-proxy.md Task 14
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { saveCredential, loadCredential, clearCredential, getStorePath } from "./store.js";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Credential } from "./types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

/** Legacy XOR-fold key + AES-GCM encrypt (pre-SHA-256 store format). */
async function legacyEncrypt(plaintext: string): Promise<string> {
  const seed = process.env.ZCODE_PROXY_CREDENTIAL_SECRET ?? `${homedir()}-${process.platform}-${process.arch}`;
  const keyBytes = new Uint8Array(new ArrayBuffer(32));
  const seedBytes = new TextEncoder().encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    keyBytes[i % 32] ^= seedBytes[i];
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return Buffer.from(combined).toString("base64");
}

describe("credential store", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns null when no credential stored", async () => {
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("roundtrips: save → load → matches original", async () => {
    const cred: Credential = {
      apiKey: "testApiKey123",
      secret: "testSecret456",
      provider: "zai",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("testApiKey123");
    expect(loaded!.secret).toBe("testSecret456");
    expect(loaded!.provider).toBe("zai");
  });

  it("roundtrips bigmodel credential (no secret)", async () => {
    const cred: Credential = {
      apiKey: "bmKey789",
      provider: "bigmodel",
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("bmKey789");
    expect(loaded!.secret).toBeUndefined();
    expect(loaded!.provider).toBe("bigmodel");
  });

  it("clearCredential removes stored credential", async () => {
    const cred: Credential = { apiKey: "x", provider: "zai" };
    await saveCredential(cred);
    clearCredential();
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("preserves expiresAt field", async () => {
    const cred: Credential = {
      apiKey: "x",
      provider: "zai",
      expiresAt: 9999999999999,
    };
    await saveCredential(cred);
    const loaded = await loadCredential();
    expect(loaded!.expiresAt).toBe(9999999999999);
  });
});

describe("credential store — SHA-256 KDF migration (R2-13)", () => {
  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("migrates a legacy XOR-fold-encrypted file: loads AND re-stores under the new KDF", async () => {
    const cred: Credential = { apiKey: "legacyKey", provider: "zai" };
    const legacyPayload = await legacyEncrypt(JSON.stringify(cred));
    writeFileSync(getStorePath(), JSON.stringify({ encrypted: legacyPayload }), "utf-8");

    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("legacyKey");

    // The file must now be re-encrypted under the NEW key: the legacy key can
    // no longer decrypt it.
    const restored = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    expect(restored.encrypted).not.toBe(legacyPayload);
    const reLoaded = await loadCredential(); // second load goes through the new KDF directly
    expect(reLoaded!.apiKey).toBe("legacyKey");
  });

  it("returns null for a file decryptable under NEITHER key (corrupt/foreign)", async () => {
    writeFileSync(getStorePath(), JSON.stringify({ encrypted: Buffer.from("garbage-not-base64-encrypted").toString("base64") }), "utf-8");
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });

  it("returns null for valid-base64 but undecryptable ciphertext", async () => {
    // Encrypt under a DIFFERENT secret → both the new and legacy keys fail.
    const saved = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "a-totally-different-secret";
    const foreign = await legacyEncrypt(JSON.stringify({ apiKey: "x", provider: "zai" }));
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = saved;

    writeFileSync(getStorePath(), JSON.stringify({ encrypted: foreign }), "utf-8");
    const loaded = await loadCredential();
    expect(loaded).toBeNull();
  });
});
