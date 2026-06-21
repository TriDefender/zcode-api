import { describe, it, expect } from "bun:test";
import {
  RequestLogStore,
  usageFromResponseBody,
  usageFromSsePayload,
  mergeTokenUsage,
} from "./request-logs.js";

describe("RequestLogStore", () => {
  it("stores and summarizes logs", () => {
    const store = new RequestLogStore(10);
    store.append({
      id: "#001",
      format: "anthropic",
      model: "glm-5.2",
      stream: false,
      status: 200,
      ttfbMs: 120,
      tokens: 42,
      inputTokens: 1000,
      outputTokens: 42,
      cachedTokens: 800,
      tokPerSec: 10,
      totalMs: 500,
      accountUserId: "user-1",
    });
    const { entries, total, summary } = store.list();
    expect(total).toBe(1);
    expect(entries[0]?.model).toBe("glm-5.2");
    expect(entries[0]?.cachedTokens).toBe(800);
    expect(summary.last24h).toBe(1);
    expect(summary.totalTokens24h).toBe(42);
    expect(summary.totalInputTokens24h).toBe(1000);
    expect(summary.totalCachedTokens24h).toBe(800);
    expect(summary.cacheHitRate24h).toBe(80);
  });
});

describe("usage parsers", () => {
  it("reads Anthropic message_start usage", () => {
    const u = usageFromSsePayload({
      type: "message_start",
      message: { usage: { input_tokens: 500, cache_read_input_tokens: 400 } },
    });
    expect(u).toEqual({ inputTokens: 500, cachedTokens: 400 });
  });

  it("reads Responses API response.completed usage", () => {
    const u = usageFromSsePayload({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1200,
          output_tokens: 88,
          input_tokens_details: { cached_tokens: 900 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    });
    expect(u).toEqual({
      inputTokens: 1200,
      outputTokens: 88,
      cachedTokens: 900,
      reasoningTokens: 12,
    });
  });

  it("reads Anthropic JSON message body", () => {
    const u = usageFromResponseBody({
      type: "message",
      usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 200 },
    });
    expect(u).toEqual({ inputTokens: 300, outputTokens: 50, cachedTokens: 200 });
  });

  it("merges usage patches", () => {
    const merged = mergeTokenUsage(
      { inputTokens: 10, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
      { outputTokens: 20, cachedTokens: 5 },
    );
    expect(merged.outputTokens).toBe(20);
    expect(merged.inputTokens).toBe(10);
    expect(merged.cachedTokens).toBe(5);
  });
});
