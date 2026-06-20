/**
 * Full Start Plan onboarding: OAuth → sync desktop creds → provision quota → proxy store.
 */
import type { Credential } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import {
  writeDesktopCredentials,
  syncStartPlanConfigJwt,
  decodeJwtUserId,
} from "./zcode-credentials.js";
import { waitForQuotaBuckets } from "./billing.js";
import { launchZcode, stopZcode } from "./zcode-launcher.js";

export interface OnboardOptions {
  provider: ProviderId;
  jwt: string;
  accessToken: string;
  userId?: string;
  userInfo?: Record<string, unknown>;
  /** Launch ZCode GUI to trigger bucket allocation (default true). */
  launchDesktop?: boolean;
  quotaTimeoutMs?: number;
}

export interface OnboardResult {
  credential: Credential;
  quotaReady: boolean;
  balanceCount: number;
}

export async function onboardStartPlan(opts: OnboardOptions): Promise<OnboardResult> {
  const userId = opts.userId ?? decodeJwtUserId(opts.jwt);

  console.log("Writing credentials to ~/.zcode/v2/credentials.json ...");
  writeDesktopCredentials({
    jwt: opts.jwt,
    accessToken: opts.accessToken,
    userId,
    userInfo: opts.userInfo,
    activeProvider: opts.provider,
  });
  syncStartPlanConfigJwt(opts.jwt);

  if (opts.launchDesktop !== false) {
    console.log("Launching ZCode to provision Start Plan quota (close automatically when ready)...");
    try {
      launchZcode();
    } catch (err) {
      console.warn(`Could not launch ZCode: ${(err as Error).message}`);
      console.warn("Continuing with API-only quota polling...");
    }
  }

  console.log("Waiting for billing balance buckets...");
  const balance = await waitForQuotaBuckets(opts.jwt, {
    timeoutMs: opts.quotaTimeoutMs ?? 120_000,
  });

  if (opts.launchDesktop !== false) {
    stopZcode();
  }

  const quotaReady = balance.balances.length > 0;
  if (quotaReady) {
    const first = balance.balances[0];
    console.log(
      `Quota ready: ${balance.balances.length} bucket(s), ` +
        `${first?.show_name ?? "model"} has ${first?.remaining_units ?? "?"} tokens left`,
    );
  } else {
    console.warn(
      "Quota buckets still empty. Open ZCode, send one message in the app, then run: auth import-jwt",
    );
  }

  const credential: Credential = {
    apiKey: opts.accessToken,
    provider: opts.provider,
    jwt: opts.jwt,
    userId,
  };

  return {
    credential,
    quotaReady,
    balanceCount: balance.balances.length,
  };
}
