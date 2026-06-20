import { describe, it, expect } from "bun:test";
import {
  encryptCredential,
  decryptStoredCredential,
  decodeJwtUserId,
} from "./zcode-credentials.js";

describe("zcode-credentials", () => {
  it("encrypt/decrypt round-trips", () => {
    const plain = "eyJhbGciOi.test.jwt";
    const enc = encryptCredential(plain);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptStoredCredential(enc)).toBe(plain);
  });

  it("decodeJwtUserId reads user_id from payload", () => {
    const payload = Buffer.from(JSON.stringify({ user_id: "abc-123" })).toString("base64url");
    const jwt = `x.${payload}.y`;
    expect(decodeJwtUserId(jwt)).toBe("abc-123");
  });
});
