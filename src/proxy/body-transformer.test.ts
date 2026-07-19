/**
 * Tests for body transformer.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { transformRequestBody } from "./body-transformer.js";

describe("transformRequestBody — general", () => {
  it("returns undefined unchanged", () => {
    expect(transformRequestBody(undefined, { format: "openai" })).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(transformRequestBody("", { format: "openai" })).toBe("");
  });

  it("returns original body on JSON parse failure", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "openai" })).toBe(broken);
  });

  it("returns original body when JSON is not an object", () => {
    expect(transformRequestBody("[1,2,3]", { format: "openai" })).toBe("[1,2,3]");
    expect(transformRequestBody("\"hello\"", { format: "openai" })).toBe("\"hello\"");
  });

  it("returns original body when no transformation applies", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });
});

describe("transformRequestBody — stream_options.include_usage (OpenAI)", () => {
  it("injects stream_options.include_usage when stream:true and missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: true });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options fields, only adds include_usage", () => {
    const body = JSON.stringify({ stream: true, stream_options: { some_other: "x" } });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ some_other: "x", include_usage: true });
  });

  it("does NOT touch body when stream_options.include_usage already true", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is false", () => {
    const body = JSON.stringify({ stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject for anthropic format (Anthropic API has no stream_options)", () => {
    const body = JSON.stringify({ stream: true });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — cache_control (Anthropic)", () => {
  it("adds cache_control to last user message with string content", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last user msg content converted to array with cache_control on the block
    expect(parsed.messages[2].content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    // Earlier messages untouched
    expect(parsed.messages[0].content).toBe("first question");
    expect(parsed.messages[1].content).toBe("answer");
  });

  it("adds cache_control to last content block when content is already array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT overwrite existing cache_control on last block", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual(existing);
  });

  it("skips system messages — finds last non-system", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q1" },
        { role: "system", content: "sys-prompt" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // The user msg (index 0) is the last non-system; gets cache_control
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System untouched
    expect(parsed.messages[1].content).toBe("sys-prompt");
  });

  it("does nothing when messages array is empty", () => {
    const body = JSON.stringify({ messages: [] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("does nothing when messages are all system", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });

  it("does NOT apply cache_control for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    expect(out).toBe(body);
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-4.6" });
    expect(transformRequestBody(body, { format: "anthropic" })).toBe(body);
  });
});

describe("transformRequestBody — combined behavior", () => {
  it("OpenAI streaming body is only stream_options-modified (no cache_control)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.messages[0].content).toBe("hi");
  });
});

describe("transformRequestBody — start-plan system (Anthropic)", () => {
  it("prepends current ZCode system messages as three cacheable blocks plus currentModel block", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(4);
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are ZCode, an interactive coding agent",
      cache_control: { type: "ephemeral" },
    });
    expect(parsed.system[1].text).toContain("# Harness");
    expect(parsed.system[1].text).toContain("interactive ZCode agent");
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[2].text).toContain("You have been invoked in the following environment:");
    expect(parsed.system[2].text).toContain("- Is a git repository: no");
    expect(parsed.system[2].text).not.toContain("- Is a git repository: unknown");
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[3]).toEqual({
      type: "text",
      text: "- You are powered by the model named glm-5.2.",
      cache_control: { type: "ephemeral" },
    });
  });

  it("omits the currentModel block when body.model is missing", () => {
    const body = JSON.stringify({
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[2].text).toContain("You have been invoked in the following environment:");
  });

  it("omits the currentModel block when body.model is an empty string", () => {
    const body = JSON.stringify({
      model: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
  });

  it("does not treat non-string body.model as a currentModel", () => {
    const body = JSON.stringify({
      model: { nested: "object" },
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
  });

  it("preserves client system text after ZCode's official blocks", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: "User rule",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(5);
    expect(parsed.system[4]).toEqual({ type: "text", text: "User rule" });
  });
});

describe("transformRequestBody — start-plan system (OpenAI)", () => {
  it("prepends current ZCode system messages (incl. currentModel) before OpenAI chat messages", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "openai", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: "You are ZCode, an interactive coding agent",
    });
    expect(parsed.messages[1].role).toBe("system");
    expect(parsed.messages[1].content).toContain("# Harness");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content).toContain("You have been invoked in the following environment:");
    expect(parsed.messages[2].content).toContain("- Is a git repository: no");
    expect(parsed.messages[3]).toEqual({
      role: "system",
      content: "- You are powered by the model named glm-5.2.",
    });
    expect(parsed.messages[4]).toEqual({ role: "user", content: "hi" });
  });

  it("omits the currentModel system message when body.model is missing (OpenAI)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });

    const out = transformRequestBody(body, { format: "openai", startPlan: true });
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0].role).toBe("system");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content).toContain("You have been invoked in the following environment:");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch body when metadata.user_id already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    expect(transformRequestBody(body, { format: "anthropic", userId: "u_x" })).toBe(body);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent (apikey mode)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata for OpenAI format even if userId is set", () => {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });
});
