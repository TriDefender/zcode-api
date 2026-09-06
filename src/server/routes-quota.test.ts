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
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
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

/** Mock fetch that records billing calls and answers both endpoints. */
function makeBillingFetch(opts: { code?: number; body?: unknown } = {}): { fetchImpl: typeof fetch; calls: BillingCall[] } {
  const calls: BillingCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/api/v1/zcode-plan/billing/")) {
      calls.push({ url: u, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      const code = opts.code ?? 0;
      return new Response(JSON.stringify({ code, msg: "ok", data: opts.body ?? { server_time: 1720000000, balances: [], plans: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { type: "not_found", message: u } }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
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
  it("no overrides → real platform/arch, never undefined-undefined", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: undefined, ZCODE_IDENTITY_ARCH: undefined }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      const snap = await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      expect(calls.length).toBe(2);
      const expected = `${process.platform}-${os.arch()}`;
      expect(snap.errors).toEqual([]);
      for (const c of calls) {
        const url = new URL(c.url);
        expect(url.searchParams.get("platform")).toBe(expected);
        expect(url.searchParams.get("app_version")).toBe("test-1.0.0");
        expect(c.headers["X-Platform"]).toBe(expected);
      }
      expect(calls[0].url).toContain("/billing/balance?");
      expect(calls[1].url).toContain("/billing/preview?");
    });
  });

  it("valid overrides → both billing calls use the overridden fingerprint", async () => {
    await withEnv({ ZCODE_IDENTITY_PLATFORM: "linux", ZCODE_IDENTITY_ARCH: "x64" }, async () => {
      const { fetchImpl, calls } = makeBillingFetch();
      await collectQuotaSnapshot(makeConfig(), fetchImpl, loadFake);
      for (const c of calls) {
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
      for (const c of calls) {
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
