/**
 * Tests for the auth-code OAuth flow handlers.
 *
 * Z.AI and Bigmodel now share the same auth-code machinery (verified against
 * the ZCode 3.1.x bundle). Tests target the ZAI config (chat.z.ai authorize,
 * zcode.z.ai token exchange) and the shared localhost-callback + exchange logic.
 *
 * @see .omo/plans/zcode-proxy.md Task 9
 */
import { describe, it, expect } from "bun:test";
import { ZaiOAuthClient } from "./oauth.js";

/**
 * Wrap response data in the zcode.z.ai `{code, data, msg}` envelope that the
 * shared token endpoint returns for every provider.
 */
function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({ code: 0, data, msg: "success" });
}

describe("ZaiOAuthClient (auth-code flow)", () => {
  it("buildAuthorizeUrl targets chat.z.ai with standard OAuth2 params (response_type/client_id/redirect_uri)", async () => {
    const client = new ZaiOAuthClient();
    const { authorizeUrl } = await client.start();
    try {
      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://chat.z.ai/api/oauth/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
      expect(url.searchParams.get("redirect_uri")).toStartWith("http://127.0.0.1:");
      expect(url.searchParams.get("redirect_uri")).toEndWith("/oauth/callback/zai");
      expect(url.searchParams.get("state") ?? "").toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await client.close();
    }
  });

  it("exchangeCode unwraps the envelope and extracts zai.access_token + jwt + userId", async () => {
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      return new Response(
        envelope({
          token: "jwt_zcode",
          zai: { access_token: "zai_access_123" },
          user: { user_id: "u1", name: "test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    const result = await client.exchangeCode("code_xyz", "http://127.0.0.1:9/callback/zai", "st");
    expect(result.accessToken).toBe("zai_access_123");
    expect(result.jwt).toBe("jwt_zcode");
    expect(result.userId).toBe("u1");
  });

  it("exchangeCode throws when data.zai.access_token is missing", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return new Response(envelope({ token: "jwt_only" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    expect(client.exchangeCode("code", "redirect", "st")).rejects.toThrow(/data\.zai\.access_token/);
  });

  it("exchangeCode throws on non-zero business code", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return new Response(JSON.stringify({ code: 3004, msg: "invalid_code" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    expect(client.exchangeCode("code", "redirect", "st")).rejects.toThrow(/invalid_code/);
  });

  it("exchangeCode throws on HTTP error", async () => {
    const mockFetch = (async (_input: RequestInfo | URL): Promise<Response> => {
      return new Response("server error", { status: 500 });
    }) as typeof fetch;

    const client = new ZaiOAuthClient(mockFetch);
    expect(client.exchangeCode("code", "redirect", "st")).rejects.toThrow(/token exchange failed/);
  });

  it("authorize() runs the full flow: callback redirect + token exchange", async () => {
    // Mock fetch only answers the token-exchange POST.
    const exchangeFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://zcode.z.ai/api/v1/oauth/token");
      return new Response(
        envelope({
          token: "jwt_full",
          zai: { access_token: "resolved_token" },
          user: { user_id: "user_42" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new ZaiOAuthClient(exchangeFetch);

    // Simulate the provider redirecting to the localhost callback by hitting
    // the authorize URL's `redirect` + `state` as soon as it is known.
    let capturedUrl = "";
    const result = await client.authorize((url) => {
      capturedUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
      const state = parsed.searchParams.get("state") ?? "";
      fetch(`${redirectUri}?authCode=code_from_provider&state=${state}`).catch(() => {});
    });

    expect(capturedUrl).toContain("chat.z.ai/api/oauth/authorize");
    expect(result.accessToken).toBe("resolved_token");
    expect(result.provider).toBe("zai");
    expect(result.userId).toBe("user_42");
    expect(result.jwt).toBe("jwt_full");
  });
});
