/**
 * JWT age inspection for the stored start-plan token.
 *
 * The upstream issues `zcodejwttoken` with a short server-side session; the
 * token payload carries `iat` but no `exp`, so staleness is judged by age.
 * Empirically the billing gateway starts returning `3012 unusual activity` /
 * empty 401s once the token is hours old, while the chat path keeps working
 * off warm upstream state — a silent failure that is hard to debug. Surfacing
 * the age lets operators (and the /quota endpoint) warn before that happens.
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

/** Age (hours) beyond which the start-plan JWT is considered stale for billing APIs. */
export const JWT_STALE_HOURS = 6;
