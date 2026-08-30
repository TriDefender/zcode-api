/**
 * Credential and auth type definitions.
 * @see .omo/plans/zcode-proxy.md Task 4
 * @see _reverse/NOTEPAD.md "How Credential is Used"
 */
import type { ProviderId } from "../provider/types.js";

/** A resolved credential ready to be injected into upstream requests. */
export interface Credential {
  /** The API key portion (e.g. Z.AI API key id, or Bigmodel API key). */
  apiKey: string;
  /** The secret portion (Z.AI only — appended as `{apiKey}.{secret}`). */
  secret?: string;
  /** Which provider this credential is for. */
  provider: ProviderId;
  /** Unix timestamp (ms) when the credential expires. Present only for OAuth. */
  expiresAt?: number;
  /** Upstream user identifier (OAuth only). Injected as `metadata.user_id` on Anthropic-format requests. */
  userId?: string;
  /** JWT token for start-plan (zcode.z.ai). Present when login captured the ZCode plan token. */
  jwt?: string;
}

/**
 * Convert a `Credential` to the string sent upstream.
 *
 * - Z.AI: `{apiKey}.{secret}` (secret required)
 * - Bigmodel: `{apiKey}` (no secret)
 */
export function credentialString(cred: Credential): string {
  if (cred.secret) {
    return `${cred.apiKey}.${cred.secret}`;
  }
  return cred.apiKey;
}

/** Check whether a credential has expired. */
export function isExpired(cred: Credential, now: number = Date.now()): boolean {
  if (cred.expiresAt === undefined) return false;
  return now >= cred.expiresAt;
}
