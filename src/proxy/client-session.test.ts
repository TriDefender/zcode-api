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
