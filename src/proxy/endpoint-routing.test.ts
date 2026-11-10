import { describe, expect, it } from "bun:test";
import { EndpointRoutingService, requiresClaimCaptcha } from "./endpoint-routing.js";
import type { ProxyIdentity } from "../config/types.js";

const identity: ProxyIdentity = { appVersion: "3.8.1", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" };

const ZAI_ANTHROPIC = "https://api.z.ai/api/anthropic/v1/messages";
const ZAI_ULTRA = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";

function okConfigFetch(...bodies: string[]): typeof fetch {
  let call = 0;
  return (async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("EndpointRoutingService", () => {
  it("config fetch carries the control-plane identity set with a BARE User-Agent (no SDK suffix)", async () => {
    // CL-26/CL-27: only the LLM request path carries the
    // `ai-sdk/anthropic/...` UA suffix and the csn header set — control-plane
    // fetches (endpoint routing) keep the HRt identity shape and bare UA.
    let seenUserAgent = "";
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenUserAgent = headers.get("User-Agent") ?? "";
        return new Response(JSON.stringify({
          code: 0,
          data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    await svc.resolve(ZAI_ANTHROPIC);
    expect(seenUserAgent).toBe("ZCode/3.8.1");
  });

  it("rewrites a mapped URL and preserves the query string", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: okConfigFetch(JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] } },
      })),
    });
    const resolved = await svc.resolve(`${ZAI_ANTHROPIC}?beta=true`);
    expect(resolved.routed).toBeTrue();
    expect(resolved.url).toBe(`${ZAI_ULTRA}?beta=true`);
  });

  it("returns the original URL for unmatched hosts and paths", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: okConfigFetch(JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] } },
      })),
    });
    for (const url of [
      "https://api.z.ai/api/coding/paas/v4/chat/completions",
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
      "https://zcode.z.ai/api/v1/zcode-plan/chat/completions",
    ]) {
      const resolved = await svc.resolve(url);
      expect(resolved.routed).toBeFalse();
      expect(resolved.url).toBe(url);
    }
  });

  it("matches a from-URL with a trailing slash against a request without one", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: okConfigFetch(JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [{ from: `${ZAI_ANTHROPIC}/`, to: ZAI_ULTRA }] } },
      })),
    });
    const resolved = await svc.resolve(ZAI_ANTHROPIC);
    expect(resolved.routed).toBeTrue();
    expect(resolved.url).toBe(ZAI_ULTRA);
  });

  it("fails open (original URL) and retries only after the failure cooldown", async () => {
    let clock = 0;
    let calls = 0;
    const svc = new EndpointRoutingService({
      identity,
      now: () => clock,
      fetchImpl: (async () => {
        calls++;
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const resolved = await svc.resolve(ZAI_ANTHROPIC);
    expect(resolved.routed).toBeFalse();
    expect(resolved.url).toBe(ZAI_ANTHROPIC);
    await svc.resolve(ZAI_ANTHROPIC);
    expect(calls).toBe(1); // within the 30s cooldown: no refetch
    clock = 31_000;
    await svc.resolve(ZAI_ANTHROPIC);
    expect(calls).toBe(2); // cooldown expired: retried
  });

  it("fails open when the envelope is malformed or code != 0", async () => {
    for (const bad of ['{"code":5,"data":{}}', '{"code":0}', "not-json-at-all"]) {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(bad) });
      const resolved = await svc.resolve(ZAI_ANTHROPIC);
      expect(resolved.routed).toBeFalse();
    }
  });

  it("caches a successful snapshot for the success TTL and refreshes after expiry", async () => {
    let clock = 0;
    let calls = 0;
    const svc = new EndpointRoutingService({
      identity,
      now: () => clock,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({
          code: 0,
          data: { proxyEndpoint: { mapping: calls === 1 ? [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] : [] } },
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeTrue();
    clock = 200_000;
    expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeTrue(); // still cached (TTL 300s)
    clock = 301_000;
    expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse(); // refreshed to empty mapping
    expect(calls).toBe(2);
  });

  it("deduplicates concurrent refreshes into a single fetch", async () => {
    let calls = 0;
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: (async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({
          code: 0,
          data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] } },
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const [a, b, c] = await Promise.all([
      svc.resolve(ZAI_ANTHROPIC),
      svc.resolve(ZAI_ANTHROPIC),
      svc.resolve(ZAI_ANTHROPIC),
    ]);
    expect(calls).toBe(1);
    expect(a.routed && b.routed && c.routed).toBeTrue();
  });

  it("attaches the QSt header set (identity minus X-ZCode-Agent) + x-api-key + Accept on the config fetch", async () => {
    let seen: Headers | undefined;
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response('{"code":0,"data":{}}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await svc.resolve(ZAI_ANTHROPIC, "keyid.keysecret");
    expect(seen!.get("x-api-key")).toBe("keyid.keysecret");
    expect(seen!.get("user-agent")).toBe("ZCode/3.8.1");
    expect(seen!.get("x-zcode-app-version")).toBe("3.8.1");
    expect(seen!.get("x-zcode-agent")).toBeNull();
    expect(seen!.get("accept")).toBe("application/json");
  });

  it("rejects non-https mapping entries and keeps routing off for that snapshot", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: okConfigFetch(JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: "http://evil.example/v1" }] } },
      })),
    });
    const resolved = await svc.resolve(ZAI_ANTHROPIC);
    expect(resolved.routed).toBeFalse();
  });

  describe("zcodeAuthorizationHeader (3.16.2 X-ZCode-Authorization)", () => {
    const FLAG = "X-ZCode-Authorization";

    function flaggedConfig(to: string, marker: unknown = FLAG): string {
      return JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to, zcodeAuthorizationHeader: marker }] } },
      });
    }

    it("returns X-ZCode-Authorization: Bearer <jwt> for a flagged ultra entry", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA)) });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, "keyid.keysecret", "raw.jwt.value");
      expect(resolved.routed).toBeTrue();
      expect(resolved.url).toBe(ZAI_ULTRA);
      expect(resolved.headers).toEqual({ "X-ZCode-Authorization": "Bearer raw.jwt.value" });
    });

    it("keeps an already-Bearer-prefixed jwt verbatim (case-insensitive check)", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA)) });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, undefined, "bearer tok");
      expect(resolved.headers).toEqual({ "X-ZCode-Authorization": "bearer tok" });
    });

    it("omits the header (fail-open, routing still applies) without a jwt", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA)) });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, "keyid.keysecret");
      expect(resolved.routed).toBeTrue();
      expect(resolved.headers).toBeUndefined();
    });

    it("omits the header for a non-printable jwt", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA)) });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, undefined, "jwt\nwith-newline");
      expect(resolved.routed).toBeTrue();
      expect(resolved.headers).toBeUndefined();
    });

    it("accepts a lowercase marker value and ultra subpath targets", async () => {
      const svc = new EndpointRoutingService({
        identity,
        fetchImpl: okConfigFetch(flaggedConfig("https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages/", "x-zcode-authorization")),
      });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, undefined, "jwt");
      expect(resolved.routed).toBeTrue();
      expect(resolved.headers).toEqual({ "X-ZCode-Authorization": "Bearer jwt" });
    });

    it("rejects the whole snapshot when the marker names a different header", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA, "X-Custom-Auth")) });
      expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse();
    });

    it("rejects the whole snapshot when the marker is not a string", async () => {
      const svc = new EndpointRoutingService({ identity, fetchImpl: okConfigFetch(flaggedConfig(ZAI_ULTRA, 1)) });
      expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse();
    });

    it("rejects the whole snapshot when the flagged target leaves the ultra paths", async () => {
      const svc = new EndpointRoutingService({
        identity,
        fetchImpl: okConfigFetch(flaggedConfig("https://zcode.z.ai/api/v1/other/anthropic/v1/messages")),
      });
      expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse();
    });

    it("rejects the whole snapshot when the flagged target is cross-origin", async () => {
      const svc = new EndpointRoutingService({
        identity,
        fetchImpl: okConfigFetch(flaggedConfig("https://evil.example/api/v1/ultra/anthropic/v1/messages")),
      });
      expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse();
    });

    it("does not look ultra-like through a shared prefix (/api/v1/ultra-zai is not /api/v1/ultra/*)", async () => {
      // /api/v1/ultra-zai is in the allowlist itself; a sibling like
      // /api/v1/ultra-other must NOT pass the /api/v1/ultra prefix test.
      const svc = new EndpointRoutingService({
        identity,
        fetchImpl: okConfigFetch(flaggedConfig("https://zcode.z.ai/api/v1/ultra-other/v1/messages")),
      });
      expect((await svc.resolve(ZAI_ANTHROPIC)).routed).toBeFalse();
    });

    it("unflagged entries never carry headers", async () => {
      const svc = new EndpointRoutingService({
        identity,
        fetchImpl: okConfigFetch(JSON.stringify({
          code: 0,
          data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA, zcodeAuthorizationHeader: "" }] } },
        })),
      });
      const resolved = await svc.resolve(ZAI_ANTHROPIC, undefined, "jwt");
      expect(resolved.routed).toBeTrue();
      expect(resolved.headers).toBeUndefined();
    });
  });
});

describe("3.16.3 configs.captcha request-verification switch", () => {
  function configFetchWith(captcha: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify({
      code: 0,
      data: { proxyEndpoint: { mapping: [{ from: ZAI_ANTHROPIC, to: ZAI_ULTRA }] }, configs: { captcha } },
    }), { status: 200 })) as unknown as typeof fetch;
  }

  it("parses data.configs.captcha (snake_case → camelCase) on the same snapshot", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: configFetchWith({ enabled: true, skip_model_request: false }),
    });
    expect(await svc.getRequestVerificationConfig()).toEqual({ enabled: true, skipModelRequest: false });
  });

  it("returns null while the server has not shipped the block (live state 2026-10-23)", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: (async () => new Response(JSON.stringify({
        code: 0,
        data: { proxyEndpoint: { mapping: [] }, configs: {} },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await svc.getRequestVerificationConfig()).toBeNull();
  });

  it("records only the decisive booleans; non-boolean/garbage values degrade neutrally", async () => {
    const neutral = new EndpointRoutingService({
      identity,
      fetchImpl: configFetchWith({ enabled: "false", skip_model_request: "true" }),
    });
    expect(await neutral.getRequestVerificationConfig()).toEqual({});
    const garbage = new EndpointRoutingService({ identity, fetchImpl: configFetchWith("not-an-object") });
    expect(await garbage.getRequestVerificationConfig()).toBeNull();
  });

  it("3.18.0: region/prefix/sceneId pass through when non-empty strings (renderer Aliyun SDK init params)", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: configFetchWith({
        enabled: true,
        skip_model_request: false,
        region: "sgp",
        prefix: "no8xfe",
        sceneId: "11xygtvd",
      }),
    });
    expect(await svc.getRequestVerificationConfig()).toEqual({
      enabled: true,
      skipModelRequest: false,
      region: "sgp",
      prefix: "no8xfe",
      sceneId: "11xygtvd",
    });
  });

  it("3.18.0: non-string / blank captcha init params are dropped (ows active-block shape)", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: configFetchWith({ enabled: true, region: 42, prefix: "   ", sceneId: null }),
    });
    expect(await svc.getRequestVerificationConfig()).toEqual({ enabled: true });
  });

  it("a malformed captcha block never fails the mapping refresh", async () => {
    const svc = new EndpointRoutingService({ identity, fetchImpl: configFetchWith([1, 2]) });
    const resolved = await svc.resolve(ZAI_ANTHROPIC);
    expect(resolved.routed).toBeTrue();
    expect(await svc.getRequestVerificationConfig()).toBeNull();
  });

  it("fails open on fetch errors (null → captcha stays required)", async () => {
    const svc = new EndpointRoutingService({
      identity,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(await svc.getRequestVerificationConfig()).toBeNull();
  });

  it("honors the snapshot TTL: a fresh cache does not refetch for the config read", async () => {
    let clock = 0;
    let calls = 0;
    const svc = new EndpointRoutingService({
      identity,
      now: () => clock,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({
          code: 0,
          data: { proxyEndpoint: { mapping: [] }, configs: { captcha: { skip_model_request: true } } },
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await svc.getRequestVerificationConfig()).toEqual({ skipModelRequest: true });
    expect(await svc.getRequestVerificationConfig()).toEqual({ skipModelRequest: true });
    expect(calls).toBe(1);
    clock = 301_000;
    expect(await svc.getRequestVerificationConfig()).toEqual({ skipModelRequest: true });
    expect(calls).toBe(2);
  });

  it("requiresClaimCaptcha mirrors requiresRequestVerification's defaults", () => {
    // absent / null / neutral → required (pre-3.16.3 wire)
    expect(requiresClaimCaptcha(undefined)).toBeTrue();
    expect(requiresClaimCaptcha(null)).toBeTrue();
    expect(requiresClaimCaptcha({})).toBeTrue();
    expect(requiresClaimCaptcha({ enabled: true, skipModelRequest: false })).toBeTrue();
    // explicit server switches → skipped
    expect(requiresClaimCaptcha({ enabled: false })).toBeFalse();
    expect(requiresClaimCaptcha({ skipModelRequest: true })).toBeFalse();
    expect(requiresClaimCaptcha({ enabled: false, skipModelRequest: true })).toBeFalse();
  });
});
