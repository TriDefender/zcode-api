/**
 * JWT age inspection for the stored start-plan token.
 *
 * Informational only: the token payload carries `iat` but no `exp`, and the
 * billing gateway does NOT reject by age — an 8-day-old JWT still serves
 * `billing/balance` (verified live). Re-login is only needed when the gateway
 * actually returns 401 / 3012. The age is surfaced so operators can see how
 * fresh the credential is.
 */
export interface JwtInfo {
  /** Unix seconds when the token was issued. */
  iat: number;
  /** Token age in hours at the time of inspection. */
  ageHours: number;
  userId?: string;
}

/** Decode a zcode-plan JWT payload without verifying the signature. */
export function inspectJwt(jwt: string): JwtInfo | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as {
      iat?: number;
      user_id?: string;
      sub?: string;
    };
    if (typeof payload.iat !== "number") return null;
    return {
      iat: payload.iat,
      ageHours: Math.max(0, (Date.now() / 1000 - payload.iat) / 3600),
      ...(payload.user_id ? { userId: payload.user_id } : {}),
    };
  } catch {
    return null;
  }
}
