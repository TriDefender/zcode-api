/**
 * Remote provider-config resolver tests: pure extraction + the two-stage
 * fetch (client/configs → CDN) with TTL / dedup / fail-open semantics.
 * All HTTP goes through the test fetch seam — never the network.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  __resetHighspeedProviderConfigForTests,
  __setProviderConfigFetchForTests,
  extractHighspeedBaseUrls,
  resolvedHighspeedLlmUrl,
  warmHighspeedProviderConfig,
} from "./provider-config.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function builtinDoc(zai: string, bigmodel: string): unknown {
  return {
    schemaVersion: 2,
    revision: 43,
    config: {
      providerConfigRules: {
        providerRules: [
          { providerId: "account:zai-individual-coding-plan", config: { api: { baseUrl: "https://api.z.ai/api/anthropic" } } },
          { providerId: "account:zai-highspeed-card", config: { api: { baseUrl: zai } } },
          { providerId: "account:bigmodel-highspeed-card", config: { api: { baseUrl: bigmodel } } },
        ],
      },
    },
  };
}

const CONFIGS_BODY = { code: 0, data: { configs: { builtin_provider_config_json: "https://cdn.example.test/builtin.json" } } };

/** Fetch impl routing client/configs → body, everything else (CDN) → doc. */
function twoStageFetch(opts: { configs?: unknown; cdn?: unknown; configsStatus?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("/api/v1/client/configs")) {
      return jsonResponse(opts.configs ?? CONFIGS_BODY, opts.configsStatus ?? 200);
    }
    return jsonResponse(opts.cdn ?? builtinDoc("https://cdn.example.test/hs/anthropic", "https://cdn.example.test/hs/anthropic"));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const defaultNow = () => Date.now();

beforeEach(() => {
  __resetHighspeedProviderConfigForTests();
  __setProviderConfigFetchForTests(null);
});

afterEach(() => {
  __resetHighspeedProviderConfigForTests();
  __setProviderConfigFetchForTests(null);
});

describe("extractHighspeedBaseUrls", () => {
  it("extracts both families from a zcode-builtin shaped document", () => {
    const bases = extractHighspeedBaseUrls(builtinDoc("https://a.example.test/hs", "https://b.example.test/hs"));
    expect(bases.zai).toBe("https://a.example.test/hs");
    expect(bases.bigmodel).toBe("https://b.example.test/hs");
  });

  it("returns {} for malformed shapes", () => {
    for (const bad of [null, 42, "x", {}, { config: {} }, { config: { providerConfigRules: {} } },
      { config: { providerConfigRules: { providerRules: "nope" } } },
      // entries with non-string / blank baseUrl are skipped, not fatal
      { config: { providerConfigRules: { providerRules: [
        { providerId: "account:zai-highspeed-card", config: { api: { baseUrl: 7 } } },
        { providerId: "account:bigmodel-highspeed-card", config: { api: { baseUrl: "  " } } },
      ] } } }]) {
      expect(extractHighspeedBaseUrls(bad)).toEqual({});
    }
  });

  it("ignores unrelated provider ids and keeps a partial extraction", () => {
    const doc = { config: { providerConfigRules: { providerRules: [
      { providerId: "account:zai-individual-coding-plan", config: { api: { baseUrl: "https://api.z.ai/api/anthropic" } } },
      { providerId: "account:zai-highspeed-card", config: { api: { baseUrl: "https://hs.example.test/anthropic" } } },
    ] } } };
    expect(extractHighspeedBaseUrls(doc)).toEqual({ zai: "https://hs.example.test/anthropic" });
  });
});

describe("warmHighspeedProviderConfig + resolvedHighspeedLlmUrl", () => {
  it("resolves the CDN base and appends /v1/messages per family", async () => {
    const { impl, calls } = twoStageFetch({ cdn: builtinDoc("https://a.example.test/hs/anthropic/", "https://b.example.test/hs/anthropic") });
    __setProviderConfigFetchForTests(impl);
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "3.17.2", now: defaultNow });
    // two-stage: configs then CDN, with app_version/platform params
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("app_version=3.17.2");
    expect(calls[0]).toContain("platform=win32-x64");
    expect(calls[1]).toBe("https://cdn.example.test/builtin.json");
    // trailing slash on the base is trimmed before the SDK-style path join
    expect(resolvedHighspeedLlmUrl("zai")).toBe("https://a.example.test/hs/anthropic/v1/messages");
    expect(resolvedHighspeedLlmUrl("bigmodel")).toBe("https://b.example.test/hs/anthropic/v1/messages");
  });

  it("serves the snapshot within TTL without refetching, refetches after expiry", async () => {
    let clock = 1_000_000;
    const { impl, calls } = twoStageFetch();
    __setProviderConfigFetchForTests(impl);
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: () => clock });
    expect(calls.length).toBe(2);
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: () => clock + 60_000 });
    expect(calls.length).toBe(2); // cached
    clock += 60 * 60 * 1000 + 1;
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: () => clock });
    expect(calls.length).toBe(4); // TTL expired → fresh two-stage fetch
  });

  it("deduplicates concurrent warm calls into one in-flight fetch pair", async () => {
    const { impl, calls } = twoStageFetch();
    __setProviderConfigFetchForTests(impl);
    await Promise.all([
      warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow }),
      warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow }),
    ]);
    expect(calls.length).toBe(2);
  });

  it("fails open on configs error / missing CDN field / CDN error — default stays", async () => {
    for (const opts of [
      { configsStatus: 500 },                              // configs HTTP failure
      { configs: { data: { configs: {} } } },              // no builtin_provider_config_json
      { cdn: { nonsense: true } },                         // CDN doc without our entries
    ] as const) {
      __resetHighspeedProviderConfigForTests();
      const { impl } = twoStageFetch(opts as { configs?: unknown; cdn?: unknown; configsStatus?: number });
      __setProviderConfigFetchForTests(impl);
      await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow });
      expect(resolvedHighspeedLlmUrl("zai")).toBeNull();
      expect(resolvedHighspeedLlmUrl("bigmodel")).toBeNull();
    }
  });

  it("does not cache a document lacking our entries — the next warm refetches", async () => {
    let cdnBody: unknown = { config: { providerConfigRules: { providerRules: [] } } };
    const calls: string[] = [];
    __setProviderConfigFetchForTests((async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return url.includes("/api/v1/client/configs")
        ? jsonResponse(CONFIGS_BODY)
        : jsonResponse(cdnBody);
    }) as unknown as typeof fetch);
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow });
    expect(calls.length).toBe(2);
    expect(resolvedHighspeedLlmUrl("zai")).toBeNull();
    cdnBody = builtinDoc("https://later.example.test/hs", "https://later.example.test/hs");
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow });
    expect(calls.length).toBe(4); // nothing was cached → retried immediately
    expect(resolvedHighspeedLlmUrl("zai")).toBe("https://later.example.test/hs/v1/messages");
  });

  it("never throws on network errors (warm resolves, default stays)", async () => {
    __setProviderConfigFetchForTests((async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    await warmHighspeedProviderConfig({ origin: "https://zcode.z.ai", appVersion: "v", now: defaultNow });
    expect(resolvedHighspeedLlmUrl("zai")).toBeNull();
  });
});
