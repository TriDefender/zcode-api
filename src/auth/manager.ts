/**
 * Auth manager — resolves the upstream credential from the OAuth login flow.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { Credential } from "./types.js";
import { inspectJwt, JWT_STALE_HOURS } from "./jwt-age.js";

/**
 * Resolves the upstream credential to inject into proxied requests.
 *
 * The credential comes from `auth login` and is injected via
 * {@link setOAuthCredential} at startup (and re-loaded on Android's
 * `startProxy` so a fresh login after restart is picked up).
 */
export class AuthManager {
  private oauthCred: Credential | null = null;
  /** Set once per loaded credential so the staleness warning fires once. */
  private warnedStaleJwt = false;

  /** Returns the current credential, refreshing if necessary. */
  async getCredential(): Promise<Credential> {
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required — run: zcode-proxy auth login");
      }
      this.warnIfStaleJwt(this.oauthCred);
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run: zcode-proxy auth login");
  }

  /**
   * The start-plan JWT has no `exp` upstream but stops working for billing
   * APIs within hours (chat keeps functioning off warm state). Warn once so
   * the silent-degradation failure mode is visible in logs.
   */
  private warnIfStaleJwt(cred: Credential): void {
    if (this.warnedStaleJwt || !cred.jwt) return;
    const info = inspectJwt(cred.jwt);
    if (info && info.ageHours >= JWT_STALE_HOURS) {
      this.warnedStaleJwt = true;
      console.warn(
        `[auth] start-plan JWT is ${info.ageHours.toFixed(1)}h old (issued ${new Date(info.iat * 1000).toISOString()}); ` +
        `billing APIs may reject it with 401/3012. Re-login to refresh: zcode-proxy auth login ${cred.provider}`,
      );
    }
  }

  /** Set the OAuth credential (used by the `auth login` flow). */
  setOAuthCredential(cred: Credential): void {
    this.oauthCred = cred;
    this.warnedStaleJwt = false;
  }
}
