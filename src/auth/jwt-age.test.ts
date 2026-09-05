import { describe, it, expect } from "bun:test";
import { inspectJwt } from "./jwt-age.js";

function makeJwt(payload: object): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(JSON.stringify(payload))}.sig`;
}

describe("inspectJwt", () => {
  it("decodes iat and computes age", () => {
    const iat = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const info = inspectJwt(makeJwt({ iat, user_id: "u1" }));
    expect(info).not.toBeNull();
    expect(info!.iat).toBe(iat);
    expect(info!.ageHours).toBeGreaterThan(0.9);
    expect(info!.ageHours).toBeLessThan(1.1);
    expect(info!.userId).toBe("u1");
  });

  it("returns null for garbage and missing iat", () => {
    expect(inspectJwt("not-a-jwt")).toBeNull();
    expect(inspectJwt(makeJwt({ sub: "x" }))).toBeNull();
  });

  it("reports old tokens as informational (age can exceed days)", () => {
    const iat = Math.floor(Date.now() / 1000) - 8 * 24 * 3600; // 8 days ago
    const info = inspectJwt(makeJwt({ iat }));
    expect(info).not.toBeNull();
    expect(info!.ageHours).toBeGreaterThan(190);
  });
});
