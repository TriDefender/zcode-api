/**
 * Regression tests for the GET /quota billing snapshot (routes-quota.ts).
 *
 * Covers the review round for PR #41 commit 66959ae:
 *  - the platform/arch fingerprint must be built from real values with env
 *    overrides (never `identity.platform/arch` → "undefined-undefined");
 *  - empty/whitespace env overrides fall back instead of producing `-x64`;
 *  - both billing calls share the same fingerprint;
 *  - upstream snake_case and live-observed camelCase balance fields both map;
 *  - non-numeric / NaN values never leak into the JSON snapshot.
 */
import { describe, it, expect } from "bun:test";
import os from "node:os";
import { collectQuotaSnapshot, handleQuota } from "./routes-quota.js";
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: {},
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false }, highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false, gateway: { enabled: true, upstreamOrigin: "https://zcode.chatglm.site" } },
    media: { enabled: false, upstreamOrigin: "https://zcode.chatglm.site" },
    async: {
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 100,
      controlTimeoutMs: 1000,
      defaultModel: "",
    },
    claim: { enabled: false, auto: true, origin: "https://billing.example", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    logging: { level: "info" },
    ...overrides,
  };
}

/** Minimal valid start-plan JWT payload (iat only, no exp). */
const IAT = Math.floor(Date.now() / 1000) - 8 * 24 * 3600; // 8 days old, still valid per jwt-age.ts docs
function makeJwt(): string {
  const payload = Buffer.from(JSON.stringify({ iat: IAT })).toString("base64url");
  return `h.${payload}.s`;
}

const fakeCred: Credential = { apiKey: "key-x.secret-y", provider: "zai", jwt: makeJwt() };
const loadFake = async (): Promise<Credential> => fakeCred;
const loadNone = async (): Promise<Credential | null> => null;

interface BillingCall {
  url: string;
  headers: Record<string, string>;
}

/** Mock fetch that records billing/monitor calls and answers all three endpoints. */
function makeBillingFetch(opts: {
  code?: number;
  body?: unknown;
  /** Monitor-plane (coding) envelope data; defaults to an empty limits list. */
  codingBody?: unknown;
  codingCode?: number;
  /** Simulate monitor-endpoint network/HTTP failure. */
  codingFail?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: BillingCall[] } {
  const calls: BillingCall[] = [];
  const record = (u: string, init?: RequestInit): void => {
    calls.push({ url: u, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/monitor/usage/quota/limit")) {
      record(u, init);
      if (opts.codingFail) return new Response("upstream exploded", { status: 500 });
      const code = opts.codingCode ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.codingBody ?? { level: "max", limits: [] } }), { status: 200 });
    }
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      record(u, init);
      const code = opts.code ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.body ?? { server_time: 1720000000, balances: [], plans: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", message: u } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Calls to one plane, in request order. */
function planeCalls(calls: BillingCall[], plane: "billing" | "monitor"): BillingCall[] {
  return calls.filter((c) => c.url.includes(plane === "billing" ? "/api/v1/zcode-plan/billing/" : "/api/monitor/usage/quota/limit"));
}

/** Set/restore identity env overrides around a test body. */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["ZCODE_IDENTITY_PLATFORM", "ZCODE_IDENTITY_ARCH"]) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("collectQuotaSnapshot fingerprint", () => {
  it("no overrides → real platform/arch on billing calls, raw key auth on coding call", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: undefined, ZCODE_IDENTITY_ARCH: undefined }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      const billing = planeCalls(calls, "billing");
      const monitor = planeCalls(calls, "monitor");
      expect(billing.length).toBe(2);
      expect(monitor.length).toBe(1);
      const expected = `${process.platform}-${os.arch()}`;
      expect(snap.errors).toEqual([]);
      for (const c of billing) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe(expected);
        expect(url.searchParams.get("app_version")).toBe("test-1.0.0");
        expect(c.headers["X-Platform"]).toBe(expected);
      }
      expect(billing[0].url).toContain("/billing/balance?");
      expect(billing[1].url).toContain("/billing/preview?");
      // Coding plane mirror: bundle `wK` origin + `md` single raw-key header.
      expect(monitor[0].url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
      expect(monitor[0].headers["authorization"]).toBe("key-x.secret-y");
      expect(monitor[0].headers["accept"]).toBe("application/json");
      expect(monitor[0].headers["X-Platform"]).toBeUndefined();
      expect(snap.codingPlan).toEqual({ level: "max", limits: [] });
    });
  });

  it("valid overrides → billing calls use the overridden fingerprint (coding plane unaffected)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "linux", ZCODE_IDENTITY_ARCH: "x64" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      for (const c of planeCalls(calls, "billing")) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe("linux-x64");
        expect(c.headers["X-Platform"]).toBe("linux-x64");
      }
    });
  });

  it("empty/whitespace overrides fall back to real values (no `-x64` / `linux-`)", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "  ", ZCODE_IDENTITY_ARCH: "" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      const expected = `${process.platform}-${os.arch()}`;
      for (const c of planeCalls(calls, "billing")) {
        expect(new URL(c.url).searchParams.get("platform")).toBe(expected);
      }
    });
  });

  it("no JWT credential → handleQuota returns 503 quota_unavailable envelope", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    const resp = await handleQuota(makeConfig(), fetchImpl, loadNone);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("quota_unavailable");
    expect(calls.length).toBe(0);
  });

  it("upstream nonzero code surfaces in errors, snapshot still 200", async () => {
    const { fetchImpl } = makeBillingFetch({ code: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.errors.length).toBe(2);
    expect(snap.errors[0]).toContain("3012");
  });
});

describe("collectQuotaSnapshot response mapping", () => {
  it("snake_case balance fields map (live-observed shape)", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 1000, used_units: 250, remaining_units: 750, unit_type: "token", expires_at: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.balances).toEqual([{ showName: "Free", remainingUnits: 750, totalUnits: 1000, usedUnits: 250, unitType: "token", expiresAt: 1735689600 }]);
    expect(snap.serverTime).toBe(1720000100);
  });

  it("camelCase aliases (unitType/expiresAt) map — not silently dropped", async () => {
    const body = {
      server_time: 1720000100,
      balances: [{ show_name: "Free", total_units: 100, used_units: 10, remaining_units: 90, unitType: "token", expiresAt: 1735689600 }],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.balances[0].unitType).toBe("token");
    expect(snap.balances[0].expiresAt).toBe(1735689600);
  });

  it("numeric-string timestamps/units coerce; NaN/garbage never reach the JSON", async () => {
    const body = {
      server_time: "1720000100",
      balances: [
        { show_name: "Free", total_units: "100", used_units: "x", remaining_units: "50", expires_at: "1735689600" },
        { show_name: "Bad", total_units: NaN, used_units: null, remaining_units: 7 },
      ],
    };
    const { fetchImpl } = makeBillingFetch({ body });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.serverTime).toBe(1720000100);
    expect(snap.balances[0].totalUnits).toBe(100);
    expect(snap.balances[0].usedUnits).toBe(0);
    expect(snap.balances[0].expiresAt).toBe(1735689600);
    expect(snap.balances[1].totalUnits).toBe(0); // NaN → undefined → 0, JSON.stringify would emit null
    expect(snap.balances[1].usedUnits).toBe(0);
    expect(snap.balances[1].expiresAt).toBeUndefined();
  });
});

describe("collectQuotaSnapshot coding plane", () => {
  const bigmodelCred: Credential = { apiKey: "bm-key-123", provider: "bigmodel", jwt: makeJwt() };
  const loadBigmodel = async (): Promise<Credential> => bigmodelCred;
  const jwtLessCred: Credential = { apiKey: "key-x.secret-y", provider: "zai" };
  const loadJwtLess = async (): Promise<Credential> => jwtLessCred;

  it("maps level + limits (numeric coercion, snake alias, rows without numbers dropped)", async () => {
    const { fetchImpl } = makeBillingFetch({
      codingBody: {
        level: "max",
        limits: [
          { type: "TIME_LIMIT", number: 120, usage: 84, remaining: 36, percentage: 70, next_reset_time: "1720000000", unit: "prompt" },
          { type: "no-numbers" }, // no numeric fields → display noise, dropped
          { number: 5 }, // no type → dropped (bundle `E_` keeps typed rows only)
          { type: "WEEK_LIMIT", remaining: 500 },
        ],
      },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toEqual({
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: "prompt", total: 120, used: 84, remaining: 36, percentage: 70, nextResetTime: 1720000000 },
        { type: "WEEK_LIMIT", remaining: 500 },
      ],
    });
  });

  it("code 200 envelope counts as success (bundle `$_` semantics)", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 200, codingBody: { level: "pro", limits: [] } });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.errors).toEqual([]);
    expect(snap.codingPlan).toEqual({ level: "pro", limits: [] });
  });

  it("bigmodel credential → open.bigmodel.cn monitor origin with the raw key", async () => {
    const { fetchImpl, calls } = makeBillingFetch();
    await collectQuotaSnapshot(makeConfig({ provider: "bigmodel" }), fetchImpl, loadBigmodel);
    const monitor = planeCalls(calls, "monitor");
    expect(monitor[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(monitor[0].headers["authorization"]).toBe("bm-key-123");
  });

  it("zai_cn credential folds into the bigmodel family → open.bigmodel.cn monitor origin", async () => {
    // The config providers map has no zai_cn key — desktop
    // resolveStartPlanFamilyFromOAuthProvider maps zai_cn → "bigmodel".
    const zaiCnCred: Credential = { apiKey: "cn-key-x.secret-y", provider: "zai_cn", jwt: makeJwt() };
    const { fetchImpl, calls } = makeBillingFetch();
    await collectQuotaSnapshot(makeConfig(), fetchImpl, async () => zaiCnCred);
    const monitor = planeCalls(calls, "monitor");
    expect(monitor[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(monitor[0].headers["authorization"]).toBe("cn-key-x.secret-y");
  });

  it("monitor endpoint failure degrades to codingPlan null + errors entry, credits data intact", async () => {
    const { fetchImpl } = makeBillingFetch({
      body: { server_time: 1, balances: [{ show_name: "Free", total_units: 10, remaining_units: 5 }] },
      codingFail: true,
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 500");
    expect(snap.balances).toHaveLength(1);
  });

  it("nonzero monitor envelope code surfaces in errors, snapshot still resolves", async () => {
    const { fetchImpl } = makeBillingFetch({ codingCode: 3012 });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("coding: 3012");
  });

  it("jwt-less credential still serves the coding plane (billing skipped with a note)", async () => {
    const { fetchImpl, calls } = makeBillingFetch({
      codingBody: { level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, number: 120 }] },
    });
    const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadJwtLess);
    expect(planeCalls(calls, "billing").length).toBe(0);
    expect(planeCalls(calls, "monitor").length).toBe(1);
    expect(snap.jwt).toBeNull();
    expect(snap.balances).toEqual([]);
    expect(snap.errors.length).toBe(1);
    expect(snap.errors[0]).toContain("no plan JWT");
    expect(snap.codingPlan).toEqual({ level: null, limits: [{ type: "TIME_LIMIT", remaining: 36, total: 120 }] });
  });

  it("unusable coding origin → coding plane silently skipped (fail-open)", async () => {
    const cfg = makeConfig();
    cfg.providers.zai.openaiBase = "not a url";
    const { fetchImpl, calls } = makeBillingFetch();
    const snap = await collectQuotaSnapshot(cfg, fetchImpl, loadFake);
    expect(planeCalls(calls, "monitor").length).toBe(0);
    expect(snap.codingPlan).toBeNull();
    expect(snap.errors).toEqual([]);
  });
});
