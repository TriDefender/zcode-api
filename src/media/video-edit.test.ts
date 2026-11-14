/**
 * video_edit MCP client tests — the four server facts from zcode_speech.py
 * (bare tools/call, dual Accept, SSE frames, no session handshake) plus the
 * error taxonomy. See video-edit.ts header for the contract sources.
 */
import { describe, it, expect } from "bun:test";
import { VideoEditClient, type VideoEditDeps } from "./video-edit.js";
import { MediaUpstreamError } from "./shared.js";

function makeClient(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const call = { url: String(input), init, body };
    calls.push(call);
    return await responder(call.url, init);
  }) as unknown as typeof fetch;
  const deps: VideoEditDeps = { origin: "https://zcode.test", headers: { Authorization: "Bearer jwt", "X-Bigmodel-Authorization": "Bearer key" }, fetchImpl: impl };
  return { client: new VideoEditClient(deps), calls };
}

const sse = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...(payload as { headers?: Record<string, string> }).headers, ...headers },
  });

const json = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("VideoEditClient.callTool — wire shape", () => {
  it("sends a BARE tools/call (id 1, no handshake, no session headers) to the canonical path", async () => {
    const { client, calls } = makeClient(() =>
      sse({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true } } }, { "x-request-id": "req-9" }),
    );
    const result = await client.callTool("speech_transcribe", { audio_base64: "abc" }, 1_000);
    expect(result.data).toEqual({ ok: true });
    expect(result.requestId).toBe("req-9");
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.url).toBe("https://zcode.test/api/v1/mcp/server/video_edit");
    expect(call.body.jsonrpc).toBe("2.0");
    expect(call.body.id).toBe(1);
    expect(call.body.method).toBe("tools/call");
    expect((call.body.params as { name: string; arguments: unknown }).name).toBe("speech_transcribe");
    expect((call.body.params as { arguments: unknown }).arguments).toEqual({ audio_base64: "abc" });
    const headers = new Headers(call.init?.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer jwt");
    expect(headers.get("x-bigmodel-authorization")).toBe("Bearer key");
    expect(headers.has("mcp-session-id")).toBe(false);
    expect(headers.has("mcp-protocol-version")).toBe(false);
  });

  it("parses a plain JSON response too (server may enable JSONResponse)", async () => {
    const { client } = makeClient(() => json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: 2 } } }));
    const result = await client.callTool("speech_synthesize", {}, 1_000);
    expect(result.data).toEqual({ ok: 2 });
  });

  it("falls back to JSON inside the text content when structuredContent is absent", async () => {
    const { client } = makeClient(() =>
      sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"audio_base64":"AAA="}' }] } }),
    );
    const result = await client.callTool("speech_synthesize", {}, 1_000);
    expect(result.data).toEqual({ audio_base64: "AAA=" });
  });
});

describe("VideoEditClient.callTool — failures", () => {
  it("maps JSON-RPC errors", async () => {
    const { client } = makeClient(() => sse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "schema fail" } }));
    const err = await client.callTool("speech_transcribe", {}, 1_000).catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("upstream");
    expect(err.message).toContain("-32602");
  });

  it("maps isError tool results", async () => {
    const { client } = makeClient(() => sse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "boom" }] } }));
    const err = await client.callTool("speech_transcribe", {}, 1_000).catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("upstream");
    expect(err.message).toContain("boom");
  });

  it("throws when there is no structured content at all", async () => {
    const { client } = makeClient(() => sse({ jsonrpc: "2.0", id: 1, result: {} }));
    await expect(client.callTool("speech_transcribe", {}, 1_000)).rejects.toThrow(/no structured content/);
  });

  it("maps 401 → auth, 403 → forbidden, 413 → too_large, 3xx → upstream", async () => {
    const cases: Array<[Response, MediaUpstreamError["kind"], RegExp]> = [
      [new Response("nope", { status: 401 }), "auth", /401/],
      [new Response("denied", { status: 403 }), "forbidden", /403/],
      [new Response("too big", { status: 413 }), "too_large", /45 MiB/],
      [new Response(null, { status: 307, headers: { location: "https://zcode.test/x" } }), "upstream", /trailing slash|redirect/],
    ];
    for (const [resp, kind, message] of cases) {
      const { client } = makeClient(() => resp.clone());
      const err = await client.callTool("speech_transcribe", {}, 1_000).catch((e) => e) as MediaUpstreamError;
      expect(err.kind).toBe(kind);
      expect(err.message).toMatch(message);
    }
  });
});
