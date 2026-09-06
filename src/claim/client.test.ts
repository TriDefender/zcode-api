/**
 * Tests for `src/claim/client.ts` — mock fetch asserts request shape (URL,
 * query params, headers incl. captcha/version/platform) and canned responses
 * verify preview parsing and the claim biz-code failure mapping.
 */
import { describe, it, expect, mock } from "bun:test";
import { createClaimClient } from "./client.js";
import type { ClaimFailureKind } from "./types.js";

function makeMockFetch(impl: (req: Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof url === "string" ? url : url.toString(), init);
    return impl(req, init);
  }) as unknown as typeof fetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PREVIEW_BODY = {
  code: 0,
  data: {
    plans: [
      {
        plan_id: "weekend-free-1024",
        name: "Weekend Free",
        description: "weekend trial",
        priority: 5,
        starts_at: 1783000000,
        ends_at: 1783200000,
        entitlements: [
          {
            entitlement_id: "ent-1",
            show_name: "GLM-5.2",
            meter: "token",
            unit_type: "tokens",
            capabilities: ["chat"],
            grant_units: 100000,
            period: "daily",
            priority: 1,
            effective_at: 1783000000,
          },
          { no_id: "dropped" },
        ],
      },
      { name: "no plan_id — dropped" },
    ],
  },
};

describe("createClaimClient — getPreviews", () => {
  it("fetches preview with app_version + platform query and parses plans/entitlements", async () => {
    let capturedUrl = "";
    const fetchImpl = makeMockFetch((req) => {
      capturedUrl = req.url;
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai/", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });

    const plans = await client.getPreviews();

    expect(capturedUrl).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.11.2&platform=win32-x64");
    expect(plans).toHaveLength(1);
    const p = plans[0];
    expect(p.planId).toBe("weekend-free-1024");
    expect(p.name).toBe("Weekend Free");
    expect(p.priority).toBe(5);
    expect(p.startsAt).toBe(1783000000);
    expect(p.endsAt).toBe(1783200000);
    expect(p.entitlements).toHaveLength(1);
    expect(p.entitlements[0]).toEqual({
      entitlementId: "ent-1",
      showName: "GLM-5.2",
      meter: "token",
      unitType: "tokens",
      capabilities: ["chat"],
      grantUnits: 100000,
      period: "daily",
      priority: 1,
      effectiveAt: 1783000000,
    });
  });

  it("sends Authorization only when jwt provided", async () => {
    const auths: (string | null)[] = [];
    const fetchImpl = makeMockFetch((req) => {
      auths.push(req.headers.get("authorization"));
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const withJwt = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await withJwt.getPreviews();
    const anon = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await anon.getPreviews();
    expect(auths[0]).toBe("Bearer jwt-1");
    expect(auths[1]).toBeNull();
  });

  it("throws on non-zero biz code and missing data", async () => {
    const fetchImpl = makeMockFetch(() => Promise.resolve(jsonResp({ code: 1002, msg: "campaign ended" })));
    const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await expect(client.getPreviews()).rejects.toThrow("1002");
    const fetchNoData = makeMockFetch(() => Promise.resolve(jsonResp({ code: 0 })));
    const client2 = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "win32-x64", fetchImpl: fetchNoData });
    await expect(client2.getPreviews()).rejects.toThrow("preview failed");
  });
});

describe("createClaimClient — identity header set", () => {
  it("preview and claim carry X-Device-Mid (server-required) and full identity minus X-ZCode-Agent", async () => {
    const seen: Array<{ path: string; deviceMid: string | null; agent: string | null; version: string | null; ua: string | null }> = [];
    const fetchImpl = makeMockFetch((req) => {
      seen.push({
        path: new URL(req.url).pathname,
        deviceMid: req.headers.get("x-device-mid"),
        agent: req.headers.get("x-zcode-agent"),
        version: req.headers.get("x-zcode-app-version"),
        ua: req.headers.get("user-agent"),
      });
      return Promise.resolve(jsonResp(PREVIEW_BODY));
    });
    const client = createClaimClient({
      origin: "https://zcode.z.ai",
      jwt: "jwt-1",
      appVersion: "3.11.2",
      platform: "win32-x64",
      identity: { appVersion: "3.11.2", refererOrigin: "https://zcode.z.ai", sourceTitle: "cli", deviceMid: "d4ad5b5e-1234-4abc-9def-aabbccddeeff" },
      fetchImpl,
    });

    await client.getPreviews();
    await client.claim("weekend-free-1024", { verifyParam: "t" });

    expect(seen).toHaveLength(2);
    for (const r of seen) {
      expect(r.deviceMid).toBe("d4ad5b5e-1234-4abc-9def-aabbccddeeff");
      expect(r.agent).toBeNull();
      expect(r.version).toBe("3.11.2");
      // CL-26: control-plane fetches keep the BARE ZCode UA — the
      // `ai-sdk/anthropic/...` suffix is LLM-path only.
      expect(r.ua).toBe("ZCode/3.11.2");
    }
    expect(seen[0].path).toBe("/api/v1/zcode-plan/billing/preview");
    expect(seen[1].path).toBe("/api/v1/zcode-plan/billing/claim");
  });
});

describe("createClaimClient — claim", () => {
  function capture(req: Request) {
    return {
      url: req.url,
      auth: req.headers.get("authorization"),
      captchaParam: req.headers.get("x-aliyun-captcha-verify-param"),
      captchaRegion: req.headers.get("x-aliyun-captcha-verify-region"),
      appVersion: req.headers.get("x-zcode-app-version"),
      platform: req.headers.get("x-platform"),
      contentType: req.headers.get("content-type"),
    };
  }

  it("POSTs plan_id with jwt + captcha + version + platform headers", async () => {
    let cap: ReturnType<typeof capture> | undefined;
    let body = "";
    const fetchImpl = makeMockFetch(async (req) => {
      cap = capture(req);
      body = await req.text();
      return jsonResp({ code: 0, data: { plan: { starts_at: 1783000000, ends_at: 1783200000 } } });
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "linux-x64", fetchImpl });

    const out = await client.claim("weekend-free-1024", { verifyParam: "cap-token", region: "cn-hangzhou" });

    expect(cap!.url).toBe("https://zcode.z.ai/api/v1/zcode-plan/billing/claim");
    expect(cap!.auth).toBe("Bearer jwt-1");
    expect(cap!.captchaParam).toBe("cap-token");
    expect(cap!.captchaRegion).toBe("cn-hangzhou");
    expect(cap!.appVersion).toBe("3.11.2");
    expect(cap!.platform).toBe("linux-x64");
    expect(cap!.contentType).toBe("application/json");
    expect(JSON.parse(body)).toEqual({ plan_id: "weekend-free-1024" });
    expect(out).toEqual({ ok: true, planId: "weekend-free-1024", startsAt: 1783000000, endsAt: 1783200000 });
  });

  it("omits region header when region missing/empty", async () => {
    let region: string | null = "sentinel";
    const fetchImpl = makeMockFetch((req) => {
      region = req.headers.get("x-aliyun-captcha-verify-region");
      return Promise.resolve(jsonResp({ code: 0, data: { plan: {} } }));
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
    await client.claim("p1", { verifyParam: "t" });
    expect(region).toBeNull();
  });

  it("maps biz codes to failure kinds and surfaces failureEndsAt", async () => {
    const cases: Array<[number, ClaimFailureKind]> = [
      [1001, "not_found"],
      [1002, "unavailable"],
      [1003, "already_claimed"],
      [1004, "ineligible"],
      [1005, "quota_exhausted"],
      [3001, "invalid_request"],
      [3007, "captcha"],
      [9999, "unknown"],
    ];
    for (const [code, kind] of cases) {
      const fetchImpl = makeMockFetch(() =>
        Promise.resolve(jsonResp({ code, msg: `biz ${code}`, data: { plan: { ends_at: 1783100000 } } })),
      );
      const client = createClaimClient({ origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.11.2", platform: "win32-x64", fetchImpl });
      const out = await client.claim("p1", { verifyParam: "t" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.failureKind).toBe(kind);
        expect(out.code).toBe(code);
        expect(out.failureEndsAt).toBe(1783100000);
      }
    }
  });

  it("derives http_error / login_required from HTTP status without biz code", async () => {
    const fetch500 = makeMockFetch(() => Promise.resolve(jsonResp({ msg: "boom" }, 500)));
    const c1 = createClaimClient({ origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.11.2", platform: "p", fetchImpl: fetch500 });
    const out1 = await c1.claim("p1", { verifyParam: "t" });
    expect(out1.ok).toBe(false);
    if (!out1.ok) expect(out1.failureKind).toBe("http_error");

    const fetch401 = makeMockFetch(() => Promise.resolve(new Response("", { status: 401 })));
    const c2 = createClaimClient({ origin: "https://zcode.z.ai", jwt: "j", appVersion: "3.11.2", platform: "p", fetchImpl: fetch401 });
    const out2 = await c2.claim("p1", { verifyParam: "t" });
    expect(out2.ok).toBe(false);
    if (!out2.ok) expect(out2.failureKind).toBe("login_required");
  });

  it("returns login_required without HTTP call when jwt missing", async () => {
    const fetchImpl = makeMockFetch(() => {
      throw new Error("should not be called");
    });
    const client = createClaimClient({ origin: "https://zcode.z.ai", appVersion: "3.11.2", platform: "p", fetchImpl });
    const out = await client.claim("p1", { verifyParam: "t" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failureKind).toBe("login_required");
  });
});
