import { describe, expect, it } from "bun:test";
import { EndpointRoutingService } from "./endpoint-routing.js";
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
});
