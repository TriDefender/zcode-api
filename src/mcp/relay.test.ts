/**
 * Tests for the official-MCP relay auth header matrix and streamable-HTTP
 * forwarding (header contract LIVE-VERIFIED 2026-09-25 —
 * @see _reverse/NOTEPAD.md "Official plugin MCP").
 */
import { describe, it, expect } from "bun:test";
import {
  buildOfficialMcpAuthHeaders,
  relayOfficialMcpRequest,
  McpCredentialsUnavailableError,
} from "./relay.js";
import type { Credential } from "../auth/types.js";

function cred(fields: Partial<Credential> = {}): Credential {
  return {
    apiKey: "ce3dtest.testsecret",
    provider: "zai",
    jwt: "jwt-abc",
    ...fields,
  };
}

describe("buildOfficialMcpAuthHeaders", () => {
  it("emits the live-verified header set in order", () => {
    const { mode, headers } = buildOfficialMcpAuthHeaders(cred());
    expect(mode).toBe("coding-plan");
    expect(Object.keys(headers)).toEqual(["Authorization", "X-Bigmodel-Authorization", "Bigmodel-Target-Type"]);
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(headers["X-Bigmodel-Authorization"]).toBe("Bearer ce3dtest.testsecret");
    expect(headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
  });

  it("zai composes apiKey.secret into the plan header; bigmodel uses the bare key", () => {
    const zai = buildOfficialMcpAuthHeaders(cred({ provider: "zai", apiKey: "id-part", secret: "sec-part" }));
    const bigmodel = buildOfficialMcpAuthHeaders(cred({ provider: "bigmodel", apiKey: "id-part", secret: undefined }));
    expect(zai.headers["X-Bigmodel-Authorization"]).toBe("Bearer id-part.sec-part");
    expect(bigmodel.headers["X-Bigmodel-Authorization"]).toBe("Bearer id-part");
  });

  it("fails fast when the credential has no zcode JWT", () => {
    expect(() => buildOfficialMcpAuthHeaders(cred({ jwt: undefined }))).toThrow(
      McpCredentialsUnavailableError,
    );
    try {
      buildOfficialMcpAuthHeaders(cred({ jwt: undefined }));
    } catch (err) {
      expect((err as McpCredentialsUnavailableError).reason).toBe("missing_jwt");
      expect((err as Error).message).toContain("auth login");
    }
  });

  it("trims whitespace before building header values", () => {
    const { headers } = buildOfficialMcpAuthHeaders(cred({ jwt: "  jwt-abc  ", apiKey: " key " }));
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(headers["X-Bigmodel-Authorization"]).toBe("Bearer key");
  });
});

/** Capturing fetch stub: records the last (url, init) and returns a canned Response. */
function captureFetch(resp: Response): { fetch: typeof fetch; seen: () => { url: string; init: RequestInit } } {
  let captured: { url: string; init: RequestInit } | null = null;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured = { url: String(input), init: init ?? (input instanceof Request ? {} : {}) };
    return resp;
  }) as typeof fetch;
  return { fetch: impl, seen: () => captured! };
}

describe("relayOfficialMcpRequest", () => {
  const auth = buildOfficialMcpAuthHeaders(cred());
  const UPSTREAM = "https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha";

  it("POST: forwards body, forwards only allowlisted client headers, injects auth", async () => {
    const { fetch, seen } = captureFetch(
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1", "x-internal": "nope" },
      }),
    );
    const req = new Request("http://127.0.0.1:8080/mcp/tianyancha", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer inbound-proxy-key",
        "x-api-key": "inbound-proxy-key",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": "sess-1",
        "user-agent": "some-client",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    const { response } = await relayOfficialMcpRequest(req, auth, UPSTREAM, fetch);
    const { url, init } = seen();

    expect(url).toBe(UPSTREAM);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    // Inbound proxy credentials must never reach the upstream in any form.
    expect(JSON.stringify(headers)).not.toContain("inbound-proxy-key");
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(headers["X-Bigmodel-Authorization"]).toBe("Bearer ce3dtest.testsecret");
    expect(headers["Bigmodel-Target-Type"]).toBe("PERSONAL");
    expect(headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(headers["mcp-session-id"]).toBe("sess-1");
    expect(headers.accept).toContain("text/event-stream");
    expect(headers["user-agent"]).toBeUndefined();
    expect(JSON.parse(Buffer.from(init.body as ArrayBuffer).toString("utf8")).method).toBe("tools/list");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("mcp-session-id")).toBe("sess-1");
    expect(response.headers.get("x-internal")).toBeNull();
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("GET: query string is preserved and no body is sent", async () => {
    const { fetch, seen } = captureFetch(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const req = new Request("http://127.0.0.1:8080/mcp/tianyancha?cursor=3", { method: "GET" });

    const { response } = await relayOfficialMcpRequest(req, auth, `${UPSTREAM}?cursor=3`, fetch);
    const { url, init } = seen();
    expect(url).toBe(`${UPSTREAM}?cursor=3`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();

    // SSE body streams through untouched.
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("event: message\ndata: {}\n\n");
  });

  it("DELETE: forwarded with status passthrough", async () => {
    const { fetch, seen } = captureFetch(new Response(null, { status: 204 }));
    const req = new Request("http://127.0.0.1:8080/mcp/tianyancha", {
      method: "DELETE",
      headers: { "mcp-session-id": "sess-1" },
    });
    const { response } = await relayOfficialMcpRequest(req, auth, UPSTREAM, fetch);
    expect(seen().init.method).toBe("DELETE");
    expect(response.status).toBe(204);
  });

  it("upstream network failure maps to 502 mcp_upstream_unreachable", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:8080/mcp/tianyancha", { method: "POST", body: "{}" });
    const { response } = await relayOfficialMcpRequest(req, auth, UPSTREAM, failing);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.type).toBe("mcp_upstream_unreachable");
    expect(body.error.message).toContain("ECONNREFUSED");
  });
});
