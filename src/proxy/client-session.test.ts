/**
 * Tests for local client session inference.
 */
import { describe, it, expect } from "bun:test";
import { createClientSessionResolver } from "./client-session.js";

function makeReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const CFG = { mode: "enforce" as const, ttlSeconds: 900, maxSessions: 1024 };

describe("client session resolver", () => {
  it("preserves explicit ZCode-style metadata IDs without hashing them", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_client_1",
        traceId: "trace_client_1",
        queryId: "query_turn_1",
        sessionId: "sess_thread_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const result = resolver.resolve(makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(result.source).toBe("explicit");
    expect(result.requestId).toBe("req_client_1");
    expect(result.traceId).toBe("trace_client_1");
    expect(result.queryId).toBe("query_turn_1");
    expect(result.sessionId).toBe("sess_thread_1");
    expect(result.upstreamSessionId).toBe("sess_thread_1");
  });

  it("preserves explicit subagent session headers for emission-time prefix stripping", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const result = resolver.resolve(makeReq(body, {
      "x-request-id": "req_header_1",
      "x-zcode-trace-id": "trace_header_1",
      "x-query-id": "query_header_1",
      "x-session-id": "subagent_agent_worker_1",
    }), body, "anthropic", "glm-4.6", CFG);

    expect(result.source).toBe("explicit");
    expect(result.requestId).toBe("req_header_1");
    expect(result.traceId).toBe("trace_header_1");
    expect(result.queryId).toBe("query_header_1");
    expect(result.sessionId).toBe("subagent_agent_worker_1");
    expect(result.upstreamSessionId).toBe("subagent_agent_worker_1");
  });

  it("keeps existing snake_case metadata session fallbacks", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        request_id: "req_legacy_1",
        trace_id: "trace_legacy_1",
        query_id: "query_legacy_1",
        session_id: "sess_legacy_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const result = resolver.resolve(makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(result.requestId).toBe("req_legacy_1");
    expect(result.traceId).toBe("trace_legacy_1");
    expect(result.queryId).toBe("query_legacy_1");
    expect(result.sessionId).toBe("sess_legacy_1");
  });
  it("keeps lineage session inference when metadata only provides trace IDs", () => {
    const resolver = createClientSessionResolver();
    const body1 = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_turn_1",
        traceId: "trace_turn_1",
        queryId: "query_turn_1",
      },
      messages: [{ role: "user", content: "Hi" }],
    });
    const body2 = JSON.stringify({
      model: "glm-4.6",
      metadata: {
        requestId: "req_turn_2",
        traceId: "trace_turn_2",
        queryId: "query_turn_2",
      },
      messages: [{ role: "user", content: "Hi" }],
    });

    const first = resolver.resolve(makeReq(body1), body1, "anthropic", "glm-4.6", CFG);
    const second = resolver.resolve(makeReq(body2), body2, "anthropic", "glm-4.6", CFG);

    expect(first.source).toBe("lineage");
    expect(first.upstreamSessionId).toBeTruthy();
    expect(first.requestId).toBe("req_turn_1");
    expect(first.traceId).toBe("trace_turn_1");
    expect(first.queryId).toBe("query_turn_1");
    expect(second.source).toBe("lineage");
    expect(second.upstreamSessionId).toBe(first.upstreamSessionId);
    expect(second.requestId).toBe("req_turn_2");
    expect(second.traceId).toBe("trace_turn_2");
    expect(second.queryId).toBe("query_turn_2");
  });
  it("reuses the same session for exact request bodies", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });

    const first = resolver.resolve(makeReq(body), body, "anthropic", "glm-4.6", CFG);
    const second = resolver.resolve(makeReq(body), body, "anthropic", "glm-4.6", CFG);

    expect(first.source).toBe("lineage");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.upstreamSessionId).toBe(first.upstreamSessionId);
    expect(second.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("reuses the same session for a linear continuation", () => {
    const resolver = createClientSessionResolver();
    const firstBody = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const nextBody = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Next" },
      ],
    });

    const first = resolver.resolve(makeReq(firstBody), firstBody, "anthropic", "glm-4.6", CFG);
    const next = resolver.resolve(makeReq(nextBody), nextBody, "anthropic", "glm-4.6", CFG);

    expect(next.sessionId).toBe(first.sessionId);
    expect(next.source).toBe("lineage");
  });

  it("creates separate sessions for forked continuations from the same parent", () => {
    const resolver = createClientSessionResolver();
    const parentBody = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const forkA = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }, { role: "user", content: "A" }],
    });
    const forkB = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "Hi" }, { role: "user", content: "B" }],
    });

    resolver.resolve(makeReq(parentBody), parentBody, "anthropic", "glm-4.6", CFG);
    const a = resolver.resolve(makeReq(forkA), forkA, "anthropic", "glm-4.6", CFG);
    const b = resolver.resolve(makeReq(forkB), forkB, "anthropic", "glm-4.6", CFG);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.upstreamSessionId).not.toBe(b.upstreamSessionId);
  });

  it("canonicalizes OpenAI requests while ignoring transport and sampling fields", () => {
    const resolver = createClientSessionResolver();
    const firstBody = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      temperature: 0.2,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "Hi" }],
    });
    const secondBody = JSON.stringify({
      model: "glm-4.6",
      stream: false,
      temperature: 0.9,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "Hi" }],
    });

    const first = resolver.resolve(makeReq(firstBody), firstBody, "openai", "glm-4.6", CFG);
    const second = resolver.resolve(makeReq(secondBody), secondBody, "openai", "glm-4.6", CFG);

    expect(second.sessionId).toBe(first.sessionId);
  });

  it("does not throw or allocate a session for malformed or empty bodies", () => {
    const resolver = createClientSessionResolver();

    const malformed = resolver.resolve(makeReq("not-json"), "not-json", "anthropic", "glm-4.6", CFG);
    const empty = resolver.resolve(makeReq(""), undefined, "anthropic", "glm-4.6", CFG);

    expect(malformed.source).toBe("none");
    expect(malformed.sessionId).toBeUndefined();
    expect(empty.source).toBe("none");
    expect(empty.sessionId).toBeUndefined();
  });
});
