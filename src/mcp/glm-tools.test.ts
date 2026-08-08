import { describe, it, expect } from "bun:test";
import { decodeWebSearchResult, GlmMcpPool } from "./glm-tools.js";
import { glmMcpEndpoint } from "./client.js";

describe("decodeWebSearchResult", () => {
  it("decodes a doubly-encoded JSON array", () => {
    // The text field is a JSON-stringified array: "[{\"title\":\"T\",\"link\":\"L\"}]"
    const inner = JSON.stringify([{ title: "T", link: "L", content: "C", refer: "ref_1" }]);
    const wrapped = JSON.stringify(inner); // outer string quotes
    const r = decodeWebSearchResult([{ type: "text", text: wrapped }]);
    expect(r).toEqual([{ title: "T", link: "L", content: "C", refer: "ref_1" }]);
  });

  it("returns [] on malformed input without throwing", () => {
    expect(decodeWebSearchResult([{ type: "text", text: "not json" }])).toEqual([]);
    expect(decodeWebSearchResult([{ type: "text", text: "" }])).toEqual([]);
    expect(decodeWebSearchResult([])).toEqual([]);
  });

  it("filters out entries missing title or link", () => {
    const inner = JSON.stringify([{ title: "ok", link: "http://x" }, { title: "no link" }, { link: "no title" }]);
    const wrapped = JSON.stringify(inner);
    const r = decodeWebSearchResult([{ type: "text", text: wrapped }]);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe("ok");
  });
});

describe("GlmMcpPool", () => {
  it("reuses one client per server across calls", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return new Response(
        `id:1\nevent:message\ndata:${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", content: [{ type: "text", text: "[]" }], isError: false } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "s" } },
      );
    }) as unknown as typeof fetch;
    const pool = new GlmMcpPool({ provider: "bigmodel", apiKey: "k", fetchImpl });
    await pool.webSearch({ search_query: "a" });
    await pool.webSearch({ search_query: "b" });
    // initialize (1) + notif (1) + call1 (1) + call2 (1) = 4; if not reusing, would be 6
    expect(calls).toBe(4);
  });
});

describe("glmMcpEndpoint (re-export sanity)", () => {
  it("matches the client's glmMcpEndpoint", () => {
    expect(glmMcpEndpoint("zai", "web_reader")).toBe("https://api.z.ai/api/mcp/web_reader/mcp");
  });
});
