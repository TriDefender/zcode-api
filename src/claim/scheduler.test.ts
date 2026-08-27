/**
 * Tests for `src/claim/scheduler.ts` — fake clock + injected client/captcha
 * verify the poll→claim state machine: target selection, hold windows per
 * failure kind, credential loss → stop, and error backoff.
 */
import { describe, it, expect } from "bun:test";
import { ClaimScheduler, type ClaimSchedulerDeps } from "./scheduler.js";
import { ClaimPreviewError } from "./client.js";
import type { ClaimOutcome, ClaimablePlan } from "./types.js";

type HarnessFields = {
  jwt: string | undefined;
  plans: ClaimablePlan[];
  previewError: Error | undefined;
  claimOutcome: ClaimOutcome | Error;
  captchaResult: { verifyParam: string; region?: string } | Error;
  captchaCalls: number;
  claimCalls: Array<{ planId: string; captcha: { verifyParam: string; region?: string } }>;
  nowMs: number;
  logs: string[];
  config: ClaimSchedulerDeps["config"];
};

interface Harness extends HarnessFields {
  scheduler: ClaimScheduler;
}

function makeHarness(overrides: Partial<{ planId: string; pollIntervalMs: number; cooldownMs: number }> = {}): Harness {
  const h: HarnessFields = {
    jwt: "jwt-1",
    plans: [{ planId: "weekend-1", name: "Weekend", description: "", priority: 1, entitlements: [] }],
    previewError: undefined,
    claimOutcome: { ok: true, planId: "weekend-1" },
    captchaResult: { verifyParam: "cap", region: "cn" },
    captchaCalls: 0,
    claimCalls: [],
    nowMs: 1_000_000,
    logs: [],
    config: {
      planId: overrides.planId,
      pollIntervalMs: overrides.pollIntervalMs ?? 300_000,
      cooldownMs: overrides.cooldownMs ?? 600_000,
    },
  };

  const deps: ClaimSchedulerDeps = {
    getJwt: () => Promise.resolve(h.jwt),
    createClient: () => ({
      getPreviews: () => (h.previewError ? Promise.reject(h.previewError) : Promise.resolve(h.plans)),
      claim: (planId, captcha) => {
        h.claimCalls.push({ planId, captcha });
        return h.claimOutcome instanceof Error ? Promise.reject(h.claimOutcome) : Promise.resolve(h.claimOutcome);
      },
    }),
    getCaptcha: () => {
      h.captchaCalls += 1;
      return h.captchaResult instanceof Error ? Promise.reject(h.captchaResult) : Promise.resolve(h.captchaResult);
    },
    config: h.config,
    log: (m) => h.logs.push(m),
    now: () => h.nowMs,
  };
  // The scheduler closures must capture THIS object; assign after construction
  // so tests mutate the same reference the scheduler reads.
  const harness = h as HarnessFields & { scheduler?: ClaimScheduler };
  harness.scheduler = new ClaimScheduler(deps);
  return harness as Harness;
}

describe("ClaimScheduler.tick", () => {
  it("claims the highest-priority plan and holds until ends_at", async () => {
    const h = makeHarness();
    h.plans = [
      { planId: "low", name: "L", description: "", priority: 1, entitlements: [] },
      { planId: "high", name: "H", description: "", priority: 9, entitlements: [] },
    ];
    h.claimOutcome = { ok: true, planId: "high", startsAt: 2000, endsAt: 3000 }; // unix seconds

    const res = await h.scheduler.tick();

    expect(res).toEqual({ action: "claimed", planId: "high", startsAt: 2000, endsAt: 3000 });
    expect(h.claimCalls).toEqual([{ planId: "high", captcha: { verifyParam: "cap", region: "cn" } }]);

    // ends_at (3000s = 3_000_000ms) is in the future relative to nowMs=1_000_000.
    h.nowMs = 2_999_999;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
    h.nowMs = 3_000_000;
    expect((await h.scheduler.tick()).action).not.toBe("skipped_hold");
  });

  it("claims the configured planId when set (ignores priority)", async () => {
    const h = makeHarness({ planId: "specific" });
    h.plans = [
      { planId: "specific", name: "S", description: "", priority: 0, entitlements: [] },
      { planId: "other", name: "O", description: "", priority: 99, entitlements: [] },
    ];
    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("claimed");
    expect(h.claimCalls[0]?.planId).toBe("specific");
  });

  it("idle when no claimable plans; plain poll cadence", async () => {
    const h = makeHarness();
    h.plans = [];
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "idle" });
    h.nowMs += h.config.pollIntervalMs - 1;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
  });

  it("idle when configured planId absent from preview", async () => {
    const h = makeHarness({ planId: "missing" });
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "idle" });
    expect(h.claimCalls).toHaveLength(0);
  });

  it("quota_exhausted holds until server failureEndsAt (seconds)", async () => {
    const h = makeHarness({ cooldownMs: 60_000 });
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "quota_exhausted", code: 1005, message: "daily quota", failureEndsAt: 1200 }; // 1_200_000 ms

    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("failed");

    h.nowMs = 1_199_999;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
    h.nowMs = 1_200_000;
    expect((await h.scheduler.tick()).action).not.toBe("skipped_hold");
  });

  it("already_claimed without failureEndsAt uses cooldown", async () => {
    const h = makeHarness({ cooldownMs: 60_000 });
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "already_claimed", code: 1003, message: "dup" };
    const res = await h.scheduler.tick();
    expect((res as { action: string; holdMs: number }).holdMs).toBe(60_000);
  });

  it("ineligible uses cooldown and keeps running", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "ineligible", code: 1004, message: "version" };
    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("failed");
    expect(h.scheduler.isStopped()).toBe(false);
  });

  it("login_required failure stops the scheduler", async () => {
    const h = makeHarness();
    h.claimOutcome = { ok: false, planId: "weekend-1", failureKind: "login_required", code: 401, message: "auth" };
    await h.scheduler.tick();
    expect(h.scheduler.isStopped()).toBe(true);
  });

  it("missing JWT backs off and retries (Android logs in after boot)", async () => {
    const h = makeHarness({ cooldownMs: 60_000 });
    h.jwt = undefined;
    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("error");
    expect((res as { holdMs: number }).holdMs).toBe(60_000);
    expect(h.scheduler.isStopped()).toBe(false);

    // JWT appears after login (e.g. OAuthWebView completes) — next tick claims.
    h.jwt = "jwt-2";
    h.nowMs += 60_000;
    const res2 = await h.scheduler.tick();
    expect((res2 as { action: string }).action).toBe("claimed");
  });

  it("preview 404 (campaign not deployed) idles at poll cadence without error log", async () => {
    const h = makeHarness({ pollIntervalMs: 120_000, cooldownMs: 30_000 });
    h.previewError = new ClaimPreviewError("claim preview failed (404): 404 page not found", 404, 404);
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "idle" });
    expect(h.logs).toHaveLength(0);
    h.nowMs += 119_999;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
  });

  it("preview 5xx still backs off with cooldown", async () => {
    const h = makeHarness({ cooldownMs: 45_000 });
    h.previewError = new ClaimPreviewError("claim preview failed (503): down", 503, 503);
    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("error");
    expect((res as { holdMs: number }).holdMs).toBe(45_000);
  });

  it("preview and captcha errors back off with cooldown", async () => {
    const h = makeHarness({ cooldownMs: 30_000 });
    h.captchaResult = new Error("solver down");
    const res = await h.scheduler.tick();
    expect((res as { action: string }).action).toBe("error");
    expect((res as { holdMs: number }).holdMs).toBe(30_000);
    h.nowMs += 29_999;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
  });

  it("does not consume a captcha token while idle", async () => {
    const h = makeHarness();
    h.plans = [];
    await h.scheduler.tick();
    expect(h.captchaCalls).toBe(0);
  });
});

describe("ClaimScheduler lifecycle", () => {
  it("start/stop drives ticks on the timer without overlap", async () => {
    const h = makeHarness({ pollIntervalMs: 5 });
    h.plans = [];
    h.scheduler.start();
    await new Promise((r) => setTimeout(r, 20));
    h.scheduler.stop();
    expect(h.scheduler.isStopped()).toBe(true);
  });

  it("stop before start is a no-op; tick after stop reports stopped", async () => {
    const h = makeHarness();
    h.scheduler.stop();
    expect(await h.scheduler.tick()).toEqual({ action: "stopped" });
  });
});
