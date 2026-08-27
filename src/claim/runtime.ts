/**
 * Wiring between the claim subsystem and the rest of the proxy: builds a
 * scheduler from a loaded `ProxyConfig` + `AuthManager` (serve path) and
 * implements the one-shot CLI flow (`zcode-proxy claim [list|now]`).
 */
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";
import { createClaimClient, ClaimPreviewError } from "./client.js";
import { ClaimScheduler } from "./scheduler.js";
import { getCaptchaToken } from "../proxy/captcha.js";
import { loadCredential } from "../auth/store.js";

/** `${process.platform}-${process.arch}` — mirrors the client's `TH()`. */
export function claimPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

export function startAutoClaim(config: ProxyConfig, auth: AuthManager): ClaimScheduler {
  const scheduler = new ClaimScheduler({
    // AuthManager first (fresh), then the encrypted store — on Android the
    // login can land in the store after boot while auth hasn't been reloaded.
    getJwt: async () => {
      try {
        const cred = await auth.getCredential();
        if (cred.jwt) return cred.jwt;
      } catch { /* fall through to the store */ }
      const stored = await loadCredential().catch(() => null);
      return stored?.jwt;
    },
    createClient: (jwt) =>
      createClaimClient({
        origin: config.claim.origin,
        jwt,
        appVersion: config.identity.appVersion,
        platform: claimPlatform(),
      }),
    getCaptcha: async () => {
      const { verifyParam, region } = await getCaptchaToken(config.identity.appVersion);
      return { verifyParam, region: region || undefined };
    },
    config: {
      planId: config.claim.planId || undefined,
      pollIntervalMs: config.claim.pollIntervalMs,
      cooldownMs: config.claim.cooldownMs,
    },
    log: (message) => console.log(`[claim] ${message}`),
  });
  scheduler.start();
  return scheduler;
}

const FAILURE_LABELS: Record<string, string> = {
  not_found: "plan does not exist",
  unavailable: "campaign ended or not claimable yet",
  already_claimed: "already claimed on this account",
  ineligible: "account or client version not eligible (needs appVersion >= campaign minimum)",
  quota_exhausted: "daily claim quota exhausted",
  invalid_request: "invalid request",
  captcha: "captcha verification failed",
  login_required: "not logged in (oauth mode required)",
  http_error: "HTTP error",
  unknown: "unknown failure",
};

/** One-shot CLI: `list` prints previews; `now` claims the target plan. */
export async function runClaimCli(config: ProxyConfig, mode: "list" | "now"): Promise<void> {
  const cred = await loadCredential();
  const jwt = cred?.jwt;
  if (!jwt) {
    console.error("Claim requires oauth mode (no JWT stored). Run: zcode-proxy auth login <zai|bigmodel>");
    process.exit(1);
  }
  const client = createClaimClient({
    origin: config.claim.origin,
    jwt,
    appVersion: config.identity.appVersion,
    platform: claimPlatform(),
  });

  let plans: ClaimablePlan[];
  try {
    plans = await client.getPreviews();
  } catch (err) {
    if (err instanceof ClaimPreviewError && err.status === 404) {
      console.log("No claimable plans: the campaign endpoint is not deployed yet (404).");
      console.log("Weekend campaigns typically go live shortly before the window — keep the proxy");
      console.log("serving with claim.enabled, or re-run this command later.");
      return;
    }
    throw err;
  }
  if (plans.length === 0) {
    console.log("No claimable plans right now.");
    return;
  }
  printPlans(plans);

  if (mode === "list") return;

  const wanted = config.claim.planId.trim();
  const target = wanted ? plans.find((p) => p.planId === wanted) : [...plans].sort((a, b) => b.priority - a.priority)[0];
  if (!target) {
    console.error(`Configured claim.planId "${wanted}" not in the preview list.`);
    process.exit(1);
  }
  if (target.planId !== plans[0].planId) console.log(`Claiming configured plan: ${target.planId}`);

  const captcha = await getCaptchaToken(config.identity.appVersion);
  const outcome = await client.claim(target.planId, { verifyParam: captcha.verifyParam, region: captcha.region || undefined });
  printOutcome(outcome);
  if (!outcome.ok) process.exit(1);
}

function printPlans(plans: ClaimablePlan[]): void {
  console.log(`Claimable plans (${plans.length}):`);
  for (const p of plans) {
    const window = [fmtTime(p.startsAt), fmtTime(p.endsAt)].filter(Boolean).join(" → ");
    console.log(`  - ${p.planId}  "${p.name}"  priority=${p.priority}${window ? `  ${window}` : ""}`);
    for (const e of p.entitlements) {
      const quota = e.grantUnits > 0 ? ` ${e.grantUnits} ${e.unitType}` : "";
      const activate = e.effectiveAt !== undefined ? ` (activates ${new Date(e.effectiveAt * 1000).toISOString()})` : "";
      console.log(`      · ${e.showName || e.entitlementId}${quota}${activate}`);
    }
  }
}

function printOutcome(outcome: ClaimOutcome): void {
  if (outcome.ok) {
    console.log(`\nClaimed: ${outcome.planId}`);
    if (outcome.startsAt !== undefined) console.log(`  activates: ${new Date(outcome.startsAt * 1000).toISOString()}`);
    if (outcome.endsAt !== undefined) console.log(`  expires:   ${new Date(outcome.endsAt * 1000).toISOString()}`);
    if (outcome.startsAt === undefined && outcome.endsAt === undefined) console.log("  active immediately");
    return;
  }
  const label = FAILURE_LABELS[outcome.failureKind] ?? FAILURE_LABELS.unknown;
  console.error(`\nClaim failed: ${label} (code ${String(outcome.code)}) — ${outcome.message}`);
  if (outcome.failureEndsAt !== undefined) {
    console.error(`  retry window opens: ${new Date(outcome.failureEndsAt * 1000).toISOString()}`);
  }
}

function fmtTime(sec: number | undefined): string {
  return sec === undefined ? "" : new Date(sec * 1000).toISOString();
}
