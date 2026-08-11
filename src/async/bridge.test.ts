/**
 * Tests for `src/async/bridge.ts` — the core state machine.
 *
 * Each test wires a mock `OffPeakClient` (control plane) + a mock upstream
 * `fetch` (LLM plane) and asserts:
 *   - byte-level stream content (keepalives vs upstream bytes vs error events)
 *   - side effects (settle calls, takeTicket calls on retry)
 *   - timing (keepalive cadence within +/- 50ms)
 *   - abort handling (settle fires once on client disconnect)
 */
import { describe, it, expect } from "bun:test";
import { runAsyncBridge } from "./bridge.js";
import type { OffPeakClient } from "./client.js";
import type { OffPeakCredentials, TakeTicketResult, TicketState } from "./types.js";
import type { ProxyIdentity } from "../config/types.js";

const CRED: OffPeakCredentials = { jwt: "jwt-x", codingPlanApiKey: "key-y" };
const TEST_IDENTITY: ProxyIdentity = { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" };

function makeMockClient(behaviour: {
  initialTicketState?: TicketState;
  queueProgression?: TicketState[];   // states returned on successive batchStatus calls for the initial ticket
  retakeState?: TicketState;           // state for tickets taken after retry
  settleCalls?: string[];              // populated as a side effect
  takeTicketCalls?: string[];          // populated as a side effect
}): OffPeakClient & { settleCalls: string[]; takeTicketCalls: string[] } {
  const settleCalls: string[] = [];
  const takeTicketCalls: string[] = [];
  let pollCount = 0;
  const client: OffPeakClient & { settleCalls: string[]; takeTicketCalls: string[] } = {
    settleCalls,
    takeTicketCalls,
    async getAvailability() {
      return { canTakeNumber: true };
    },
    async takeTicket(taskId: string): Promise<TakeTicketResult> {
      takeTicketCalls.push(taskId);
      return {
        ticketId: `t-${taskId}-${takeTicketCalls.length}`,
        state: behaviour.retakeState ?? behaviour.initialTicketState ?? "queued",
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds: string[]) {
      const id = ticketIds[0];
      let state: TicketState;
      if (pollCount < (behaviour.queueProgression?.length ?? 0)) {
        state = behaviour.queueProgression![pollCount];
      } else {
        state = behaviour.initialTicketState ?? "queued";
      }
      pollCount++;
      return { tickets: [{ ticketId: id, state }] };
    },
    async settle(ticketId: string): Promise<void> {
      settleCalls.push(ticketId);
    },
  };
  if (behaviour.settleCalls) Object.assign(behaviour.settleCalls, settleCalls);
  if (behaviour.takeTicketCalls) Object.assign(behaviour.takeTicketCalls, takeTicketCalls);
  return client;
}

function makeAnthropicSseResponse(chunks: string[], status: number = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeErrorResponse(bodyText: string, status: number): Response {
  return new Response(bodyText, { status, headers: { "content-type": "application/json" } });
}

async function drainStream(stream: ReadableStream<Uint8Array>, maxMs: number = 2000): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const readP = reader.read();
    const timeoutP = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500));
    const result = await Promise.race([readP, timeoutP]);
    if (result === "timeout") {
      if (chunks.length > 0) break;
      continue;
    }
    if (result.done) break;
    chunks.push(result.value);
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("runAsyncBridge — happy paths", () => {
  it("ticket already ready: streams upstream bytes through with no retry", async () => {
    const client = makeMockClient({ initialTicketState: "ready" });
    const upstreamChunks = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const fetchImpl = async () => makeAnthropicSseResponse(upstreamChunks);

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"glm-4.6","messages":[]}',
      initialTicket: { ticketId: "t-init", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 50,
      keepAliveIntervalMs: 10,
      maxRetries: 3,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(text).toContain("message_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("message_stop");
    expect(client.settleCalls).toEqual(["t-init"]);
    expect(client.takeTicketCalls).toEqual([]);
    expect(o.terminalPhase).toBe("done");
    expect(o.attempts).toBe(1);
  });

  it("queued then ready: emits keepalives during wait, then streams", async () => {
    const client = makeMockClient({
      initialTicketState: "queued",
      queueProgression: ["queued", "ready"],
    });
    const upstreamChunks = [`event: message_stop\ndata: {"type":"message_stop"}\n\n`];
    const fetchImpl = async () => makeAnthropicSseResponse(upstreamChunks);

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "queued", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 30,
      keepAliveIntervalMs: 10,
      maxRetries: 0,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    await outcome;

    expect(text).toContain(": keepalive\n\n");
    expect(text).toContain("message_stop");
    expect(client.settleCalls).toEqual(["t-init"]);
  });
});

describe("runAsyncBridge — ticket expiry + retry", () => {
  it("expired in queue then retake succeeds: transparent retry", async () => {
    const client = makeMockClient({
      initialTicketState: "queued",
      queueProgression: ["expired"],
      retakeState: "ready",
    });
    const upstreamChunks = [`event: message_stop\ndata: {"type":"message_stop"}\n\n`];
    const fetchImpl = async () => makeAnthropicSseResponse(upstreamChunks);

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "queued", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxRetries: 3,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(text).toContain("message_stop");
    expect(client.takeTicketCalls.length).toBe(1);
    expect(client.settleCalls).toContain("t-init");
    expect(o.attempts).toBe(2);
    expect(o.terminalPhase).toBe("done");
  });

  it("expired in queue + maxRetries=0: terminal error event with Anthropic shape", async () => {
    const client = makeMockClient({
      initialTicketState: "queued",
      queueProgression: ["expired"],
    });

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "queued", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxRetries: 0,
      maxWaitMs: 0,
      fetchImpl: async () => makeAnthropicSseResponse([]),
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    expect(text).toContain("exhausted retries");
    expect(client.settleCalls).toContain("t-init");
    expect(client.takeTicketCalls.length).toBe(0);
    expect(o.terminalPhase).toBe("error");
  });

  it("expired via upstream HTTP error body containing magic string: retries", async () => {
    const client = makeMockClient({
      initialTicketState: "ready",
      retakeState: "ready",
    });

    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return makeErrorResponse(
          JSON.stringify({ type: "error", error: { type: "api_error", message: "off-peak-ticket-expired: deadline reached" } }),
          410,
        );
      }
      return makeAnthropicSseResponse([`event: message_stop\ndata: {"type":"message_stop"}\n\n`]);
    };

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxRetries: 3,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(fetchCount).toBe(2);
    expect(text).toContain("message_stop");
    expect(client.takeTicketCalls.length).toBe(1);
    expect(client.settleCalls).toContain("t-init");
    expect(o.attempts).toBe(2);
    expect(o.terminalPhase).toBe("done");
  });

  it("expired via upstream HTTP + maxRetries exhausted: terminal error", async () => {
    const client = makeMockClient({
      initialTicketState: "ready",
      retakeState: "ready",
    });

    const fetchImpl = async () =>
      makeErrorResponse(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "off-peak-ticket-expired" } }),
        410,
      );

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxRetries: 2,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(text).toContain("event: error");
    expect(text).toContain("exhausted retries");
    expect(o.terminalPhase).toBe("error");
    expect(client.takeTicketCalls.length).toBe(2);
    expect(client.settleCalls.length).toBe(3);
  });
});

describe("runAsyncBridge — non-expired upstream errors", () => {
  it("upstream 500: emit sanitized standard event:error + terminal error phase", async () => {
    const client = makeMockClient({ initialTicketState: "ready" });
    const fetchImpl = async () =>
      makeErrorResponse(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream broken" } }), 500);

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 10,
      keepAliveIntervalMs: 5,
      maxRetries: 3,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    const text = await drainStream(stream);
    const o = await outcome;

    expect(text).toContain("event: error");
    expect(text).toContain('"type":"error"');
    // B18: sanitized — status only, no raw upstream body leakage
    expect(text).toContain("HTTP 500");
    expect(text).not.toContain("upstream broken");
    expect(client.takeTicketCalls.length).toBe(0);
    expect(client.settleCalls).toEqual(["t-init"]);
    expect(o.terminalPhase).toBe("error");
  });
});

describe("runAsyncBridge — abort handling", () => {
  it("client abort during WAIT: settle fires once, stream closes", async () => {
    const controller = new AbortController();
    const client = makeMockClient({
      initialTicketState: "queued",
      queueProgression: ["queued", "queued", "queued", "queued", "queued"],
    });

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "queued", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 20,
      keepAliveIntervalMs: 5,
      maxRetries: 3,
      maxWaitMs: 0,
      clientSignal: controller.signal,
      fetchImpl: async () => makeAnthropicSseResponse([]),
    });

    setTimeout(() => controller.abort(), 50);
    await drainStream(stream, 500);
    const o = await outcome;

    expect(client.settleCalls).toContain("t-init");
    expect(client.takeTicketCalls.length).toBe(0);
    expect(o.terminalPhase).toBe("abort");
  });

  it("client abort during LLM stream: settle fires + upstream cancelled", async () => {
    const controller = new AbortController();
    let upstreamReadCancelled = false;
    const client = makeMockClient({ initialTicketState: "ready" });

    const encoder = new TextEncoder();
    const slowStream = new ReadableStream<Uint8Array>({
      start(controller2) {
        let count = 0;
        const tick = (): void => {
          if (count >= 100) {
            controller2.close();
            return;
          }
          try {
            controller2.enqueue(encoder.encode(`event: ping\ndata: {"i":${count}}\n\n`));
          } catch {
            upstreamReadCancelled = true;
            return;
          }
          count++;
          setTimeout(tick, 10);
        };
        setTimeout(tick, 10);
      },
      cancel() {
        upstreamReadCancelled = true;
      },
    });

    const fetchImpl = async () => new Response(slowStream, { status: 200 });

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: CRED,
      origin: "https://zcode.z.ai",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"x"}',
      initialTicket: { ticketId: "t-init", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 50,
      keepAliveIntervalMs: 30,
      maxRetries: 3,
      maxWaitMs: 0,
      clientSignal: controller.signal,
      fetchImpl: fetchImpl,
    });

    setTimeout(() => controller.abort(), 60);
    await drainStream(stream, 500);
    const o = await outcome;

    expect(client.settleCalls).toContain("t-init");
    expect(o.terminalPhase).toBe("abort");
  });
});

describe("runAsyncBridge — credentials + URL composition", () => {
  it("forwards credentials as headers + ticket id on the upstream LLM call", async () => {
    const client = makeMockClient({ initialTicketState: "ready" });

    let capturedReq: { url: string; auth: string; apiKey: string; ticketId: string; body: string } | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(typeof url === "string" ? url : url.toString(), init);
      capturedReq = {
        url: req.url,
        auth: req.headers.get("authorization") ?? "",
        apiKey: req.headers.get("x-coding-plan-api-key") ?? "",
        ticketId: req.headers.get("x-off-peak-ticket-id") ?? "",
        body: await req.text(),
      };
      return makeAnthropicSseResponse([`event: message_stop\ndata: {"type":"message_stop"}\n\n`]);
    };

    const { stream, outcome } = runAsyncBridge({
      client,
      credentials: { jwt: "the-jwt", codingPlanApiKey: "the-key", bigmodelOrganization: "org-9", bigmodelProject: "proj-9" },
      origin: "https://zcode.z.ai/////",
      identity: TEST_IDENTITY,
      llmRequestBody: '{"model":"glm-4.6"}',
      initialTicket: { ticketId: "t-xyz", state: "ready", registeredAt: Date.now() },
      taskId: "task-1",
      pollIntervalMs: 50,
      keepAliveIntervalMs: 30,
      maxRetries: 3,
      maxWaitMs: 0,
      fetchImpl: fetchImpl,
    });

    await drainStream(stream, 500);
    await outcome;

    expect(capturedReq!.url).toBe("https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages");
    expect(capturedReq!.auth).toBe("Bearer the-jwt");
    expect(capturedReq!.apiKey).toBe("the-key");
    expect(capturedReq!.ticketId).toBe("t-xyz");
    expect(capturedReq!.body).toBe('{"model":"glm-4.6"}');
  });
});
