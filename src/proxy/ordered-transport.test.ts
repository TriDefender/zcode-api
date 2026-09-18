/**
 * Tests for abort propagation through the ordered (raw-TCP) transport (CL-04).
 *
 * The handler's ordered branch used to drop the client's AbortSignal: a client
 * cancel during a long-TTFB reasoning request left the upstream LLM call
 * running (and consuming quota) for the whole generation. These tests pin:
 *   - signal fires mid-request → promise rejects + the SERVER-side socket
 *     closes (the connection is torn down, not just ignored)
 *   - pre-aborted signal → rejected before anything hits the wire
 *   - handler-level: ordered + abort → connect-retry ladder does NOT retry
 *     (single upstream request) and the client gets a 502
 */
import { describe, it, expect } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sendOrderedUpstreamRequest, orderedAdvertisedCodings } from "./ordered-transport.js";
import { proxyRequest, capOrderedAcceptEncoding } from "./handler.js";
import { AuthManager } from "../auth/manager.js";
import type { ProxyConfig, ProxyIdentity } from "../config/types.js";

interface SilentServer {
  server: Server;
  url: string;
  requests: () => number;
  serverSocketClosed: () => number;
  requestSeen: Promise<void>;
}

/** HTTP server that accepts requests and holds them open (never responds). */
async function startSilentServer(): Promise<SilentServer> {
  let requests = 0;
  let closed = 0;
  let requestSeenResolve!: () => void;
  const requestSeen = new Promise<void>((r) => {
    requestSeenResolve = r;
  });
  const server = createServer((req, res) => {
    requests += 1;
    req.socket.on("close", () => {
      closed += 1;
    });
    requestSeenResolve();
    // intentionally never respond
    void res;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    requests: () => requests,
    serverSocketClosed: () => closed,
    requestSeen,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("sendOrderedUpstreamRequest — abort propagation", () => {
  it("aborts mid-request: promise rejects and the server-side socket closes", async () => {
    const s = await startSilentServer();
    try {
      const controller = new AbortController();
      const promise = sendOrderedUpstreamRequest({
        url: `${s.url}/v1/messages`,
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: '{"model":"x"}',
        signal: controller.signal,
      });
      await s.requestSeen;
      controller.abort();
      await expect(promise).rejects.toThrow();
      expect(await waitFor(() => s.serverSocketClosed() > 0)).toBe(true);
      expect(s.requests()).toBe(1);
    } finally {
      s.server.close();
    }
  });

  it("pre-aborted signal: rejects before anything reaches the wire", async () => {
    const s = await startSilentServer();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        sendOrderedUpstreamRequest({
          url: `${s.url}/v1/messages`,
          method: "POST",
          headers: [["content-type", "application/json"]],
          body: "{}",
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(s.requests()).toBe(0);
    } finally {
      s.server.close();
    }
  });
});

const IDENTITY: ProxyIdentity = {
  appVersion: "test-1.0.0",
  sourceTitle: "cli",
  refererOrigin: "https://zcode.z.ai",
};

async function compressBytes(plain: string, format: Bun.CompressionFormat): Promise<Uint8Array> {
  const compressor = CompressionStream as unknown as new (format: Bun.CompressionFormat) => CompressionStream;
  const stream = new Blob([plain]).stream().pipeThrough(new compressor(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CodedServer {
  server: Server;
  url: string;
  seenAcceptEncoding: () => string | undefined;
}

async function startCodedServer(coding: string, format: Bun.CompressionFormat, body: string, sse: boolean): Promise<CodedServer> {
  let acceptEncoding: string | undefined;
  const server = createServer((req, res) => {
    acceptEncoding = req.headers["accept-encoding"];
    void req.resume();
    void compressBytes(body, format).then((bytes) => {
      res.writeHead(200, {
        "content-type": sse ? "text/event-stream; charset=utf-8" : "application/json",
        "content-encoding": coding,
        "content-length": String(bytes.byteLength),
      });
      res.end(bytes);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}`, seenAcceptEncoding: () => acceptEncoding };
}

describe("sendOrderedUpstreamRequest — response decompression", () => {
  it("inflates a brotli-coded body (ultra CDN SSE behavior, observed 2026-09-18)", async () => {
    const payload = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
    const s = await startCodedServer("br", "brotli", payload, true);
    try {
      const resp = await sendOrderedUpstreamRequest({
        url: `${s.url}/v1/messages`,
        method: "POST",
        headers: [["content-type", "application/json"], ["accept-encoding", "gzip, deflate, br, zstd"]],
        body: "{}",
        decompress: true,
      });
      expect(resp.headers.get("content-encoding")).toBeNull();
      expect(await resp.text()).toBe(payload);
    } finally {
      s.server.close();
    }
  });

  it("inflates a gzip-coded body (regression)", async () => {
    const payload = '{"ok":true}';
    const s = await startCodedServer("gzip", "gzip", payload, false);
    try {
      const resp = await sendOrderedUpstreamRequest({
        url: `${s.url}/v1/messages`,
        method: "POST",
        headers: [["content-type", "application/json"], ["accept-encoding", "gzip"]],
        body: "{}",
        decompress: true,
      });
      expect(resp.headers.get("content-encoding")).toBeNull();
      expect(await resp.text()).toBe(payload);
    } finally {
      s.server.close();
    }
  });

  it("decompress=false passes coded bytes through untouched", async () => {
    const payload = `raw-coded-bytes ${"lorem ipsum dolor sit amet ".repeat(24)}`;
    const s = await startCodedServer("br", "brotli", payload, false);
    try {
      const resp = await sendOrderedUpstreamRequest({
        url: `${s.url}/v1/messages`,
        method: "POST",
        headers: [["content-type", "application/json"], ["accept-encoding", "br"]],
        body: "{}",
        decompress: false,
      });
      expect(resp.headers.get("content-encoding")).toBe("br");
      const raw = new Uint8Array(await resp.arrayBuffer());
      expect(raw.byteLength).toBeGreaterThan(0);
      expect(raw.byteLength).toBeLessThan(payload.length);
      expect(new TextDecoder().decode(raw)).not.toContain("raw-coded-bytes");
    } finally {
      s.server.close();
    }
  });
});

describe("capOrderedAcceptEncoding", () => {
  const base: Array<[string, string]> = [
    ["content-type", "application/json"],
    ["accept-encoding", "gzip, deflate, br, zstd"],
    ["x-api-key", "k"],
  ];

  it("drops tokens the transport cannot inflate, preserving client order", () => {
    const capped = capOrderedAcceptEncoding(base, ["gzip", "deflate"]);
    expect(capped[1]).toEqual(["accept-encoding", "gzip, deflate"]);
    expect(capped.map(([k]) => k)).toEqual(["content-type", "accept-encoding", "x-api-key"]);
  });

  it("keeps the list verbatim when every token is supported", () => {
    expect(capOrderedAcceptEncoding(base, ["gzip", "deflate", "br", "zstd"])).toBe(base);
  });

  it("falls back to identity when nothing remains", () => {
    const pairs: Array<[string, string]> = [["accept-encoding", "br, zstd"]];
    expect(capOrderedAcceptEncoding(pairs, ["gzip"])[0]).toEqual(["accept-encoding", "identity"]);
  });

  it("strips q-weights and drops wildcards", () => {
    const pairs: Array<[string, string]> = [["accept-encoding", "gzip;q=1.0, *;q=0.5, br;q=0.8"]];
    expect(capOrderedAcceptEncoding(pairs, ["gzip", "br"])[0]).toEqual(["accept-encoding", "gzip, br"]);
  });

  it("keeps an identity-only list stable", () => {
    const pairs: Array<[string, string]> = [["accept-encoding", "identity"]];
    expect(capOrderedAcceptEncoding(pairs, ["gzip"])).toBe(pairs);
  });

  it("real runtime codings include gzip and br on Bun", () => {
    expect(orderedAdvertisedCodings()).toContain("gzip");
    expect(orderedAdvertisedCodings()).toContain("br");
  });
});

describe("proxyRequest — ordered transport + brotli SSE (ultra gateway regression)", () => {
  it("translated OpenAI stream over a br-coded Anthropic SSE upstream yields events", async () => {
    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"glm-4.6","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const s = await startCodedServer("br", "brotli", sseBody, true);
    try {
      const config: ProxyConfig = {
        server: { port: 8080, host: "127.0.0.1" },
        auth: {},
        provider: "zai",
        plan: "coding-plan",
        providers: {
          zai: { anthropicBase: s.url, openaiBase: s.url },
          bigmodel: { anthropicBase: s.url, openaiBase: s.url },
        },
        defaultModel: "glm-4.6",
        models: ["glm-4.6"],
        identity: IDENTITY,
        clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
        responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
        endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
        clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
        mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
        async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
        claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
        logging: { level: "info" },
      };
      const auth = new AuthManager();
      auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai" });

      const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "accept-encoding": "gzip, deflate, br, zstd" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }),
      });

      const resp = await proxyRequest(clientReq, "openai", { config, auth });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");
      const text = await resp.text();
      expect(text).toContain("PONG");
      // The upstream saw the client's list (all tokens supported on Bun → cap is a no-op here).
      expect(s.seenAcceptEncoding()).toBe("gzip, deflate, br, zstd");
    } finally {
      s.server.close();
    }
  });
});

describe("proxyRequest — ordered transport abort (CL-04, handler level)", () => {
  it("client abort during ordered dispatch: no connect-retry, single upstream request, 502", async () => {
    const s = await startSilentServer();
    try {
      const config: ProxyConfig = {
        server: { port: 8080, host: "127.0.0.1" },
        auth: {},
        provider: "zai",
        plan: "coding-plan",
        providers: {
          zai: { anthropicBase: s.url, openaiBase: s.url },
          bigmodel: { anthropicBase: s.url, openaiBase: s.url },
        },
        defaultModel: "glm-4.6",
        models: ["glm-4.6"],
        identity: IDENTITY,
        // enforce mode routes the request through the ordered transport
        clientIdentity: { mode: "enforce", ttlSeconds: 900, maxSessions: 1024 },
        responses: { enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 },
        endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
        clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
        mcp: { enabled: true, webSearch: true, webReader: false, zread: false },
        async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
        claim: { enabled: false, auto: true, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
        logging: { level: "info" },
      };
      const auth = new AuthManager();
      auth.setOAuthCredential({ apiKey: "key-mock", provider: "zai" });

      const controller = new AbortController();
      const clientReq = new Request("http://127.0.0.1:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      });

      const respPromise = proxyRequest(clientReq, "anthropic", { config, auth });
      await s.requestSeen;
      controller.abort();
      const resp = await respPromise;

      expect(resp.status).toBe(502);
      // The retry ladder must NOT have re-dispatched after the abort.
      expect(s.requests()).toBe(1);
      expect(await waitFor(() => s.serverSocketClosed() > 0)).toBe(true);
    } finally {
      s.server.close();
    }
  });
});
