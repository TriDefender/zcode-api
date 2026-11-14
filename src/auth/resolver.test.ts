/**
 * Tests for coding plan key resolver.
 */
import { describe, it, expect } from "bun:test";
import { KeyResolver } from "./resolver.js";

function bizResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  responses: Record<string, (body?: string, authorization?: string, url?: string) => Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body as string | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? headers.Authorization;
    for (const [pattern, handler] of Object.entries(responses)) {
      if (url.includes(pattern)) return handler(body, authorization, url);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("KeyResolver", () => {
  it("resolveZaiBizToken THROWS on shape drift (access_token missing) instead of returning undefined (CL-06)", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ renamed_token: "biz_token_123" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.resolveZaiBizToken("access_abc")).rejects.toThrow(/unexpected shape/);
  });

  it("resolveZaiBizToken exchanges access token for biz token", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({
        access_token: "biz_token_123",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const bizToken = await resolver.resolveZaiBizToken("access_abc");
    expect(bizToken).toBe("biz_token_123");
  });

  it("resolveCustomerInfo picks default org using bundle field names", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({
        organizations: [
          { organizationId: "org1", organizationName: "Some Org", projects: [] },
          { organizationId: "org2", organizationName: "默认机构", projects: [
            { projectId: "proj1", projectName: "默认项目" },
            { projectId: "proj2", projectName: "Other" },
          ]},
        ],
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const { orgId, projectId } = await resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok");
    expect(orgId).toBe("org2");
    expect(projectId).toBe("proj1");
  });

  it("resolveCustomerInfo falls back to first org when no default", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({
        organizations: [
          { organizationId: "orgA", organizationName: "Org A", projects: [{ projectId: "projA", projectName: "Proj A" }] },
        ],
      }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const { orgId, projectId } = await resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok");
    expect(orgId).toBe("orgA");
    expect(projectId).toBe("projA");
  });

  it("resolveCustomerInfo throws when no orgs", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({ organizations: [] }),
    });
    const resolver = new KeyResolver(fetchImpl);
    expect(resolver.resolveCustomerInfo("https://api.z.ai", "Bearer tok")).rejects.toThrow(/No organizations/);
  });

  it("findOrCreateApiKey finds existing key named zcode-api-key", async () => {
    const fetchImpl = mockFetch({
      "api_keys": () => bizResponse([
        { name: "other-key", apiKey: "xxx" },
        { name: "zcode-api-key", apiKey: "existingApiKey" },
      ]),
    });
    const resolver = new KeyResolver(fetchImpl);
    const result = await resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1");
    expect(result.apiKey).toBe("existingApiKey");
  });

  it("findOrCreateApiKey creates new key when not found", async () => {
    let createdKey = false;
    const fetchImpl = mockFetch({
      "api_keys": (body) => {
        if (body) {
          createdKey = true;
          return bizResponse({ apiKey: "newApiKey123" });
        }
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const result = await resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1");
    expect(createdKey).toBe(true);
    expect(result.apiKey).toBe("newApiKey123");
  });

  it("findOrCreateApiKey THROWS when the create response loses apiKey (shape drift, CL-06)", async () => {
    const fetchImpl = mockFetch({
      "api_keys": (body) => {
        if (body) return bizResponse({ key: "renamed-field" }); // drift: apiKey → key
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1"))
      .rejects.toThrow(/unexpected shape/);
  });

  it("findOrCreateApiKey falls through to create when the listed key entry is malformed (CL-06)", async () => {
    let created = false;
    const fetchImpl = mockFetch({
      "api_keys": (body) => {
        if (body) {
          created = true;
          return bizResponse({ apiKey: "freshlyCreated" });
        }
        return bizResponse([{ name: "zcode-api-key", apiKey: "" }]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const result = await resolver.findOrCreateApiKey("https://api.z.ai", "Bearer tok", "org1", "proj1");
    expect(created).toBe(true);
    expect(result.apiKey).toBe("freshlyCreated");
  });

  it("getSecretKey retrieves secret via apiKey value", async () => {
    const fetchImpl = mockFetch({
      "copy/": () => bizResponse({ secretKey: "theSecretKey" }),
    });
    const resolver = new KeyResolver(fetchImpl);
    const secret = await resolver.getSecretKey("https://api.z.ai", "Bearer tok", "org1", "proj1", "myApiKey123");
    expect(secret).toBe("theSecretKey");
  });

  it("resolveCodingPlanCredential returns Z.AI credential with secret", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ access_token: "bizTok" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({ secretKey: "mySecret" }),
      "api_keys": (body) => {
        if (body) return bizResponse({ apiKey: "myApiKey" });
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCodingPlanCredential("accessTok", "zai");
    expect(cred.apiKey).toBe("myApiKey");
    expect(cred.secret).toBe("mySecret");
    expect(cred.provider).toBe("zai");
  });

  it("resolveCodingPlanCredential zai REJECTS on missing secretKey (3.12.3 requireSecretKey)", async () => {
    const fetchImpl = mockFetch({
      "/auth/z/login": () => new Response(JSON.stringify({ access_token: "bizTok" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({}),
      "api_keys": (body) => {
        if (body) return bizResponse({ apiKey: "myApiKey" });
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.resolveCodingPlanCredential("accessTok", "zai"))
      .rejects.toThrow(/missing secretKey/);
  });

  it("resolveCodingPlanCredential zai_cn uses the LINKED bigmodel token on bigmodel.cn (zai-side token never sent) and keeps the flavor", async () => {
    let zLoginCalls = 0;
    let bigmodelHostSeen = false;
    const fetchImpl = mockFetch({
      "/auth/z/login": () => {
        zLoginCalls += 1;
        return new Response(JSON.stringify({ access_token: "bizTok" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
      "getCustomerInfo": (_body, auth, url) => {
        // The bigmodel-family credential is the poll payload's LINKED
        // data.bigmodel token (host materialFromSnapshot:
        // `accessToken = linkedBigModel.accessToken`) — live 2026-11-14: the
        // zai-side accessToken is rejected by bigmodel.cn ("令牌已过期或验证不正确").
        if (!(url ?? "").includes("bigmodel.cn")) return new Response("wrong host", { status: 404 });
        bigmodelHostSeen = true;
        if (auth !== "linked_bm_token") return new Response("unauthorized", { status: 401 });
        return bizResponse({
          organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
        });
      },
      "api_keys/copy": () => bizResponse({ secretKey: "mySecret" }),
      "api_keys": (body) => {
        if (body) return bizResponse({ apiKey: "myApiKey" });
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCodingPlanCredential("zai_side_token", "zai_cn", undefined, {
      customerId: "bm_customer_1",
      accessToken: "linked_bm_token",
    });
    // Mirror of the host adapter: NO z/login exchange for the CN flavor.
    expect(zLoginCalls).toBe(0);
    expect(bigmodelHostSeen).toBe(true);
    expect(cred.apiKey).toBe("myApiKey.mySecret");
    // The credential keeps its flavor; consumers fold zai_cn into the bigmodel family.
    expect(cred.provider).toBe("zai_cn");
    // The LINKED token rides along for the bigmodel JWT-mint signing plane.
    expect(cred.oauthAccessToken).toBe("linked_bm_token");
  });

  it("resolveCodingPlanCredential zai_cn without a linked bigmodel credential fails with a clear message", async () => {
    const fetchImpl = mockFetch({});
    const resolver = new KeyResolver(fetchImpl);
    await expect(resolver.resolveCodingPlanCredential("zai_side_token", "zai_cn"))
      .rejects.toThrow(/no linked BigModel credential/);
  });

  it("resolveCodingPlanCredential bigmodel tolerates a missing secretKey (bundle keeps requireSecretKey unset)", async () => {
    const fetchImpl = mockFetch({
      "getCustomerInfo": () => bizResponse({
        organizations: [{ organizationId: "o1", organizationName: "默认机构", projects: [{ projectId: "p1", projectName: "默认项目" }] }],
      }),
      "api_keys/copy": () => bizResponse({}),
      "api_keys": (body) => {
        if (body) return bizResponse({ apiKey: "bmKey" });
        return bizResponse([]);
      },
    });
    const resolver = new KeyResolver(fetchImpl);
    const cred = await resolver.resolveCodingPlanCredential("accessTok", "bigmodel");
    expect(cred.apiKey).toBe("bmKey");
    expect(cred.secret).toBeUndefined();
    expect(cred.provider).toBe("bigmodel");
  });
});
