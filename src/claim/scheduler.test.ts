/**
 * Tests for `src/claim/scheduler.ts` — fake clock + injected client/captcha
 * verify the poll→claim state machine: target selection, hold windows per
 * failure kind, credential loss → stop, and error backoff.
 */
import { describe, it, expect } from "bun:test";
import { ClaimScheduler, parseClaimWindow, minutesUntilWindow, type ClaimSchedulerDeps } from "./scheduler.js";
import { ClaimPreviewError } from "./client.js";
import type { ClaimOutcome, ClaimablePlan } from "./types.js";

type HarnessFields = {
  jwt: string | undefined;
  plans: ClaimablePlan[];
  previewError: Error | undefined;
  claimOutcome: ClaimOutcome | Error;
  captchaResult: { verifyParam: string; region?: string } | Error;
  captchaCalls: number;
  claimCalls: Array<{ planId: string; captcha: { verifyParam: string; region?: string } | undefined }>;
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
      listPlans: () => (h.previewError ? Promise.reject(h.previewError) : Promise.resolve(h.plans)),
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

describe("ClaimScheduler — daily claim window (UTC+8)", () => {
  // Window below is the campaign's usual daily slot, 19:00-20:30 UTC+8.
  function windowHarness() {
    const h = makeHarness();
    h.config.window = { startMin: 19 * 60, endMin: 20 * 60 + 30 };
    return h;
  }

  it("suppresses upstream requests outside the window and holds until the next open", async () => {
    const h = windowHarness();
    // 2026-11-11T12:31:00Z = 20:31 UTC+8 — outside (end is 20:30).
    h.nowMs = Date.UTC(2026, 10, 11, 12, 31, 0);
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "idle" });
    // ~22h29m until tomorrow 19:00; hold must cover it (re-armed every poll by scheduleNext).
    h.nowMs += 22 * 60 * 60_000 + 29 * 60_000 - 1;
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
    expect(h.claimCalls).toHaveLength(0);
  });

  it("polls normally inside the window", async () => {
    const h = windowHarness();
    h.nowMs = Date.UTC(2026, 10, 11, 11, 30, 0); // 19:30 UTC+8 — inside
    const res = await h.scheduler.tick();
    expect(res).toEqual({ action: "claimed", planId: "weekend-1" });
  });

  it("after a successful claim, the next tick waits for the NEXT day's window", async () => {
    const h = windowHarness();
    h.nowMs = Date.UTC(2026, 10, 11, 11, 30, 0); // 19:30 UTC+8 — inside
    await h.scheduler.tick();
    // holdUntil = now + 23.5h (minutes until tomorrow 19:00); endsAt undefined.
    const expectedHold = 23 * 60 * 60_000 + 30 * 60_000;
    h.nowMs += expectedHold - 60_000; // 18:59 next day — still held
    expect(await h.scheduler.tick()).toEqual({ action: "skipped_hold" });
    h.nowMs = Date.UTC(2026, 10, 12, 11, 30, 0); // 19:30 next day — window open again
    expect((await h.scheduler.tick()).action).toBe("claimed");
  });

  it("window start is inclusive", async () => {
    const h = windowHarness();
    h.nowMs = Date.UTC(2026, 10, 11, 11, 0, 0); // exactly 19:00 UTC+8
    expect((await h.scheduler.tick()).action).toBe("claimed");
  });

  it("window end is exclusive (20:30:00 is outside)", async () => {
    const h = windowHarness();
    h.nowMs = Date.UTC(2026, 10, 11, 12, 30, 0); // exactly 20:30 UTC+8
    expect((await h.scheduler.tick()).action).toBe("idle");
    expect(h.claimCalls).toHaveLength(0);
  });

  it("no window configured = legacy always-poll behavior", async () => {
    const h = makeHarness(); // no window
    h.nowMs = Date.UTC(2026, 10, 11, 12, 1, 0); // 20:01 UTC+8
    expect((await h.scheduler.tick()).action).toBe("claimed");
  });
});

describe("parseClaimWindow / minutesUntilWindow", () => {
  it("parses HH:MM-HH:MM and rejects malformed input", () => {
    expect(parseClaimWindow("19:00-20:30")).toEqual({ startMin: 1140, endMin: 1230 });
    expect(parseClaimWindow("  0:05-23:59 ")).toEqual({ startMin: 5, endMin: 1439 });
    expect(parseClaimWindow("")).toBeUndefined();
    expect(parseClaimWindow(undefined)).toBeUndefined();
    expect(() => parseClaimWindow("19:00")).toThrow(/HH:MM-HH:MM/);
    expect(() => parseClaimWindow("24:00-25:00")).toThrow(/out of range/);
    expect(() => parseClaimWindow("19:00-19:00")).toThrow(/start equals end/);
  });

  it("minutesUntilWindow handles before/inside/after and midnight wrap", () => {
    const win = { startMin: 1140, endMin: 1230 }; // 19:00-20:30
    expect(minutesUntilWindow(1140, win)).toBe(0); // inside (start)
    expect(minutesUntilWindow(1229, win)).toBe(0); // inside
    expect(minutesUntilWindow(1230, win)).toBe(22 * 60 + 30); // 20:30 → next 19:00
    expect(minutesUntilWindow(600, win)).toBe(540); // 10:00 → 19:00
    expect(minutesUntilWindow(1439, win)).toBe(1141); // 23:59 → 19:00 next day (wrap)
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

describe("ClaimScheduler — 3.16.3 configs.captcha gate", () => {
  const plans: ClaimablePlan[] = [{ planId: "weekend-1", name: "Weekend", description: "", priority: 1, entitlements: [] }];

  function gateHarness(captchaRequired: ClaimSchedulerDeps["captchaRequired"]) {
    const h = {
      captchaCalls: 0,
      claimCalls: [] as Array<{ planId: string; captcha: { verifyParam: string; region?: string } | undefined }>,
    };
    const scheduler = new ClaimScheduler({
      getJwt: () => Promise.resolve("jwt-1"),
      createClient: () => ({
        listPlans: () => Promise.resolve(plans),
        claim: (planId, captcha) => {
          h.claimCalls.push({ planId, captcha });
          return Promise.resolve({ ok: true, planId } as ClaimOutcome);
        },
      }),
      getCaptcha: () => {
        h.captchaCalls += 1;
        return Promise.resolve({ verifyParam: "cap", region: "cn" });
      },
      captchaRequired,
      config: { pollIntervalMs: 300_000, cooldownMs: 600_000 },
      log: () => {},
      now: () => 1_000_000,
    });
    return { h, scheduler };
  }

  it("skips the solve and claims without captcha when the (async) gate returns false", async () => {
    const { h, scheduler } = gateHarness(async () => false);
    const result = await scheduler.tick();
    expect(result.action).toBe("claimed");
    expect(h.captchaCalls).toBe(0);
    expect(h.claimCalls).toEqual([{ planId: "weekend-1", captcha: undefined }]);
  });

  it("fails open — a throwing gate keeps the pre-3.16.3 wire (solve + captcha headers)", async () => {
    const { h, scheduler } = gateHarness(() => {
      throw new Error("config fetch exploded");
    });
    const result = await scheduler.tick();
    expect(result.action).toBe("claimed");
    expect(h.captchaCalls).toBe(1);
    expect(h.claimCalls).toEqual([{ planId: "weekend-1", captcha: { verifyParam: "cap", region: "cn" } }]);
  });
});

describe("ClaimScheduler — 3.16.3 gate true keeps the solve (default-equivalent)", () => {
  it("a gate returning true solves and claims with the captcha pair", async () => {
    const plans: ClaimablePlan[] = [{ planId: "weekend-1", name: "Weekend", description: "", priority: 1, entitlements: [] }];
    let captchaCalls = 0;
    const claimCalls: Array<{ planId: string; captcha: { verifyParam: string; region?: string } | undefined }> = [];
    const scheduler = new ClaimScheduler({
      getJwt: () => Promise.resolve("jwt-1"),
      createClient: () => ({
        listPlans: () => Promise.resolve(plans),
        claim: (planId, captcha) => {
          claimCalls.push({ planId, captcha });
          return Promise.resolve({ ok: true, planId } as ClaimOutcome);
        },
      }),
      getCaptcha: () => {
        captchaCalls += 1;
        return Promise.resolve({ verifyParam: "cap" });
      },
      captchaRequired: async () => true,
      config: { pollIntervalMs: 300_000, cooldownMs: 600_000 },
      log: () => {},
      now: () => 1_000_000,
    });
    const result = await scheduler.tick();
    expect(result.action).toBe("claimed");
    expect(captchaCalls).toBe(1);
    expect(claimCalls).toEqual([{ planId: "weekend-1", captcha: { verifyParam: "cap" } }]);
  });
});
