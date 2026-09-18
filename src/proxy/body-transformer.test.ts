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

  it("clears a non-canonical existing cache_control and re-marks with the canonical ephemeral shape (zsi+Fsi)", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("strips client cache_control on earlier non-system messages, keeps only the last-message marker", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "early", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toBeUndefined();
    expect(parsed.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent: an already-marked body is returned without modification", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "early" }] },
        { role: "assistant", content: [{ type: "text", text: "reply", cache_control: { type: "ephemeral" } }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    // Already our target shape → the original string comes back untouched
    expect(out).toBe(body);
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

/** Deterministic env for start-plan assertions (resolveEnvPromptInfo reads these). */
function withEnvPromptVars<T>(fn: () => T): T {
  const keys = ["ZCODE_IDENTITY_ENV_CWD", "ZCODE_IDENTITY_PLATFORM", "ZCODE_IDENTITY_RELEASE", "ZCODE_IDENTITY_ARCH", "SHELL"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.ZCODE_IDENTITY_ENV_CWD = "/home/dev/project";
  process.env.ZCODE_IDENTITY_PLATFORM = "linux";
  process.env.ZCODE_IDENTITY_RELEASE = "6.8.0-49-generic";
  process.env.ZCODE_IDENTITY_ARCH = "x64";
  process.env.SHELL = "/bin/bash";
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("transformRequestBody — start-plan system (Anthropic)", () => {
  it("prepends three official blocks in the ContextBuilder shape with real env values", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are ZCode, an interactive coding agent",
      cache_control: { type: "ephemeral" },
    });
    expect(parsed.system[1].text).toContain("# Harness");
    expect(parsed.system[1].text).toContain("interactive ZCode agent");
    expect(parsed.system[1].text).toContain("# ZCode Desktop Context");
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[2].text.startsWith("\n\n# Communicating with the user")).toBe(true);
    expect(parsed.system[2].text).toContain("You have been invoked in the following environment:");
    expect(parsed.system[2].text).toContain("- Primary working directory: /home/dev/project");
    expect(parsed.system[2].text).toContain("- Is a git repository: no");
    expect(parsed.system[2].text).not.toContain("- Is a git repository: unknown");
    expect(parsed.system[2].text).toContain("- Platform: linux");
    expect(parsed.system[2].text).toContain("- Shell: bash");
    expect(parsed.system[2].text).toContain("- OS Version: linux 6.8.0-49-generic x64");
    // The powered-by line lives INSIDE the Environment section, followed by
    // Context Management (bundle 3.11.2 assembleSystemMessages shape).
    expect(parsed.system[2].text).toContain("- You are powered by the model named bigmodel-api/glm-5.2.\n\n# Context management");
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("prepends the currentDate context_prefix user message (tct/Vre/blt mirror)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^<system-reminder>As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is \d{4}-\d{2}-\d{2}\.\n\n {6}IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.<\/system-reminder>$/,
        ),
      },
    ]);
    // The client's message keeps the last-message cache marker (phase 2)
    expect(parsed.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    });
  });

  it("strips client cache_control from tools (4-breakpoint budget)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "get_weather", cache_control: { type: "ephemeral" } },
        { name: "read_file" },
      ],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);
    expect(parsed.tools[0]).toEqual({ name: "get_weather" });
    expect(parsed.tools[1]).toEqual({ name: "read_file" });
  });

  it("strips client cache_control from preserved system blocks", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: [{ type: "text", text: "User rule", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);
    expect(parsed.system).toHaveLength(4);
    expect(parsed.system[3]).toEqual({ type: "text", text: "User rule" });
  });

  it("omits the powered-by line when body.model is missing", () => {
    const body = JSON.stringify({
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[2].text).toContain("You have been invoked in the following environment:");
    expect(parsed.system[2].text).not.toContain("powered by the model named");
  });

  it("omits the powered-by line when body.model is an empty string", () => {
    const body = JSON.stringify({
      model: "",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[2].text).not.toContain("powered by the model named");
  });

  it("does not treat non-string body.model as a currentModel", () => {
    const body = JSON.stringify({
      model: { nested: "object" },
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[2].text).not.toContain("powered by the model named");
  });

  it("preserves client system text after ZCode's official blocks", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: "User rule",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(4);
    expect(parsed.system[3]).toEqual({ type: "text", text: "User rule" });
  });
});

describe("transformRequestBody — start-plan system (OpenAI)", () => {
  it("prepends current ZCode system messages (currentModel line inside the Environment message) before OpenAI chat messages", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "openai", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: "You are ZCode, an interactive coding agent",
    });
    expect(parsed.messages[1].role).toBe("system");
    expect(parsed.messages[1].content).toContain("# Harness");
    expect(parsed.messages[1].content).toContain("# ZCode Desktop Context");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content.startsWith("\n\n# Communicating with the user")).toBe(true);
    expect(parsed.messages[2].content).toContain("You have been invoked in the following environment:");
    expect(parsed.messages[2].content).toContain("- Is a git repository: no");
    expect(parsed.messages[2].content).toContain("- You are powered by the model named bigmodel-api/glm-5.2.");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });

  it("omits the powered-by system message when body.model is missing (OpenAI)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "openai", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0].role).toBe("system");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content).toContain("You have been invoked in the following environment:");
    expect(parsed.messages[2].content).not.toContain("powered by the model named");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch body when metadata.user_id already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    expect(transformRequestBody(body, { format: "anthropic", metadataUserId: "u_x" })).toBe(body);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", metadataUserId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent", () => {
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
    const out = transformRequestBody(body, { format: "openai", metadataUserId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });
});
