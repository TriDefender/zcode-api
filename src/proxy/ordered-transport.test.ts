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
import { sendOrderedUpstreamRequest } from "./ordered-transport.js";
import { proxyRequest } from "./handler.js";
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
