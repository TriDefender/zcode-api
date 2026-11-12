/**
 * Auto-claim scheduler — polls the manual-claim preview endpoint and claims
 * weekend/trial plans the moment they become available (first-come-first-served:
 * the server caps daily claims with biz code 1005).
 *
 * Backoff semantics per failure kind (biz codes from the desktop client):
 *   - success / already_claimed → hold until the plan's `ends_at` (unix sec)
 *   - quota_exhausted           → hold until `failureEndsAt` (next window) else cooldown
 *   - ineligible / unavailable / not_found → cooldown
 *   - captcha / network / unknown          → cooldown (retry next window)
 *   - login_required                      → stop (needs re-login)
 *
 * `starts_at` / `ends_at` / `failureEndsAt` are unix SECONDS (the desktop
 * client compares them against `Date.now()/1e3`).
 */
import type { ClaimOutcome, ClaimablePlan } from "./types.js";
import { ClaimPreviewError } from "./client.js";

interface ClaimGateway {
  /** Merged enumeration: billing preview + marketing banner plans (wk-1030+). */
  listPlans(): Promise<ClaimablePlan[]>;
  /** `captcha` omitted → claim without captcha headers (3.16.3 switch off). */
  claim(planId: string, captcha?: { verifyParam: string; region?: string }): Promise<ClaimOutcome>;
}

interface ClaimSchedulerConfig {
  /** Claim this plan_id; empty = highest-priority preview. */
  planId?: string;
  pollIntervalMs: number;
  cooldownMs: number;
  /**
   * Daily claim window in UTC+8, `"HH:MM-HH:MM"` (24h). Outside the window
   * ticks are suppressed (no preview requests) and a successful claim holds
   * until the NEXT day's window start. `undefined` = gate off (poll always).
   */
  window?: { startMin: number; endMin: number };
}

export interface ClaimSchedulerDeps {
  getJwt(): Promise<string | undefined>;
  createClient(jwt: string): ClaimGateway;
  getCaptcha(): Promise<{ verifyParam: string; region?: string }>;
  captchaRequired?: () => Promise<boolean> | boolean;
  config: ClaimSchedulerConfig;
  log?: (message: string) => void;
  now?: () => number;
}

export type TickResult =
  | { action: "skipped_hold" }
  | { action: "stopped" }
  | { action: "idle" }
  | { action: "claimed"; planId: string; startsAt?: number; endsAt?: number }
  | { action: "failed"; outcome: Extract<ClaimOutcome, { ok: false }>; holdMs: number }
  | { action: "error"; message: string; holdMs: number };

/** Daily claim window in UTC+8 ("HH:MM-HH:MM"): outside it, don't touch upstream. */
export function parseClaimWindow(raw: string | undefined): { startMin: number; endMin: number } | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`claim.window: expected "HH:MM-HH:MM", got "${s}"`);
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (Number(m[1]) > 23 || Number(m[3]) > 23 || Number(m[2]) > 59 || Number(m[4]) > 59) {
    throw new Error(`claim.window: time out of range in "${s}"`);
  }
  if (startMin === endMin) throw new Error(`claim.window: start equals end in "${s}"`);
  return { startMin, endMin };
}

/** Minutes since local midnight mapped into the UTC+8 wall clock. */
export function utcPlus8MinutesOfDay(nowMs: number): number {
  const shifted = new Date(nowMs + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function fmtMinute(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Minutes until the window opens (startMin inclusive, endMin exclusive); 0 = inside. */
export function minutesUntilWindow(minutesOfDay: number, win: { startMin: number; endMin: number }): number {
  if (minutesOfDay < win.startMin) return win.startMin - minutesOfDay;
  if (minutesOfDay >= win.endMin) return 24 * 60 - minutesOfDay + win.startMin;
  return 0; // inside the window
}

/** Minutes until the window NEXT opens (always ≥1 — inside the window counts to tomorrow's start). */
export function minutesUntilNextStart(minutesOfDay: number, win: { startMin: number; endMin: number }): number {
  return minutesOfDay < win.startMin ? win.startMin - minutesOfDay : 24 * 60 - minutesOfDay + win.startMin;
}

export class ClaimScheduler {
  private stopped = false;
  private holdUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ClaimSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.stopped) return;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One poll→claim cycle. Exposed for tests; `start()` drives it on a timer. */
  async tick(): Promise<TickResult> {
    if (this.stopped) return { action: "stopped" };
    const nowMs = this.now();
    if (nowMs < this.holdUntil) return { action: "skipped_hold" };

    // Daily claim window (UTC+8): outside the window, don't touch upstream.
    // Hold until the next window opens; scheduleNext clamps to pollIntervalMs,
    // so the hold re-arms every ~5min without any request being sent.
    const win = this.deps.config.window;
    if (win) {
      const waitMin = minutesUntilWindow(utcPlus8MinutesOfDay(nowMs), win);
      if (waitMin > 0) {
        this.holdUntil = nowMs + waitMin * 60_000;
        this.log(`claim: outside claim window (UTC+8 ${fmtMinute(win.startMin)}-${fmtMinute(win.endMin)}) — next poll at window open (~${waitMin}m)`);
        return { action: "idle" };
      }
    }

    let jwt: string | undefined;
    try {
      jwt = await this.deps.getJwt();
    } catch (err) {
      return this.errorBackoff(`credential resolution failed: ${(err as Error).message}`);
    }
    if (!jwt) {
      // Missing JWT is "login pending" (Android logs in after boot), not fatal:
      // back off and retry — the login_required CLAIM FAILURE (server 401) is
      // the terminal case handled below.
      return this.errorBackoff("no JWT available (oauth login pending)");
    }

    const client = this.deps.createClient(jwt);
    let plans: ClaimablePlan[];
    try {
      plans = await client.listPlans();
    } catch (err) {
      // 404 = campaign endpoint not deployed yet (the expected pre-launch state
      // for weekend plans); poll at normal cadence instead of error backoff.
      if (err instanceof ClaimPreviewError && err.status === 404) {
        this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
        return { action: "idle" };
      }
      return this.errorBackoff(`preview failed: ${(err as Error).message}`);
    }
    if (plans.length === 0) {
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
      return { action: "idle" };
    }

    const target = this.pickPlan(plans);
    if (!target) {
      // Configured planId not in the current preview list — plain poll cadence.
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
      return { action: "idle" };
    }

    let captchaRequired = true;
    if (this.deps.captchaRequired) {
      try {
        captchaRequired = await this.deps.captchaRequired();
      } catch {
        captchaRequired = true;
      }
    }

    let captcha: { verifyParam: string; region?: string } | undefined;
    if (captchaRequired) {
      try {
        captcha = await this.deps.getCaptcha();
      } catch (err) {
        return this.errorBackoff(`captcha token failed: ${(err as Error).message}`);
      }
    }

    let outcome: ClaimOutcome;
    try {
      outcome = await client.claim(target.planId, captcha);
    } catch (err) {
      return this.errorBackoff(`claim request failed: ${(err as Error).message}`);
    }

    if (outcome.ok) {
      const endsAtMs = outcome.endsAt !== undefined ? outcome.endsAt * 1000 : undefined;
      // Claimed: stop polling until the NEXT window opens (success once per
      // day; re-polling inside the same window would just burn daily quota).
      const nextWindowMs = win ? minutesUntilNextStart(utcPlus8MinutesOfDay(nowMs), win) * 60_000 : undefined;
      const holdCandidates: number[] = [];
      if (endsAtMs !== undefined) holdCandidates.push(endsAtMs);
      if (nextWindowMs !== undefined) holdCandidates.push(nowMs + nextWindowMs);
      this.holdUntil = holdCandidates.length > 0
        ? Math.max(...holdCandidates)
        : nowMs + this.deps.config.pollIntervalMs;
      this.log(`claim: claimed plan ${target.planId}${outcome.startsAt !== undefined ? ` (activates ${new Date(outcome.startsAt * 1000).toISOString()})` : ""}${nextWindowMs !== undefined ? ` — next poll at next window open (~${Math.round(nextWindowMs / 60_000)}m)` : ""}`);
      return { action: "claimed", planId: target.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt };
    }

    const holdMs = this.holdForFailure(outcome.failureKind, outcome.failureEndsAt, nowMs);
    this.holdUntil = nowMs + holdMs;
    this.log(`claim: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}; retry in ${Math.round(holdMs / 1000)}s`);
    if (outcome.failureKind === "login_required") {
      this.stop();
    }
    return { action: "failed", outcome, holdMs };
  }

  private pickPlan(plans: ClaimablePlan[]): ClaimablePlan | null {
    const wanted = this.deps.config.planId?.trim();
    if (wanted) return plans.find((p) => p.planId === wanted) ?? null;
    // Server order first, highest priority breaks ties (stable sort).
    const sorted = [...plans].sort((a, b) => b.priority - a.priority);
    return sorted[0] ?? null;
  }

  private holdForFailure(kind: Extract<ClaimOutcome, { ok: false }>["failureKind"], failureEndsAtSec: number | undefined, nowMs: number): number {
    if ((kind === "already_claimed" || kind === "quota_exhausted") && Number.isFinite(failureEndsAtSec)) {
      const untilMs = (failureEndsAtSec as number) * 1000;
      if (untilMs > nowMs) return Math.min(untilMs - nowMs, 24 * 60 * 60 * 1000);
    }
    return this.deps.config.cooldownMs;
  }

  private errorBackoff(message: string): TickResult {
    const holdMs = this.deps.config.cooldownMs;
    this.holdUntil = this.now() + holdMs;
    this.log(`claim: ${message}; retry in ${Math.round(holdMs / 1000)}s`);
    return { action: "error", message, holdMs };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(this.nextDelay()));
    }, delayMs);
  }

  private nextDelay(): number {
    const remaining = this.holdUntil - this.now();
    return remaining > 0 ? remaining : this.deps.config.pollIntervalMs;
  }
}
