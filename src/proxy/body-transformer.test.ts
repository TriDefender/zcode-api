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
  it("prepends three official blocks in the ContextBuilder shape (3.17.1: no Environment in system)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    // 3.15.1+ wire: cli_prefix block carries NO cache_control (stable/dynamic do).
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are ZCode, an interactive agent",
    });
    expect(parsed.system[1].text).toContain("# Harness");
    expect(parsed.system[1].text).toContain("working with the user toward their goals");
    // Desktop Context deliberately not injected (CLI-face state, NOTEPAD §J)
    expect(parsed.system[1].text).not.toContain("# ZCode Desktop Context");
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    // 3.17.1 moved Environment Info / powered-by / currentDate out of the
    // system blocks into meta_user attachments — and the minimal-set
    // anchoring (2026-10-30) ships an EMPTY block 3 (gateway-unconstrained,
    // probe M1): the default path carries identity only.
    expect(parsed.system[2].text).toBe("");
    expect(parsed.system[2].text).not.toContain("# Environment");
    expect(parsed.system[2].text).not.toContain("powered by the model named");
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("prepends the standalone date attachment user message ($5o/fce mirror)", () => {
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
          /^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/,
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

  it("client system keeps the 3-block shape; text becomes block 3 (C1: replaces the dynamic duo)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: [{ type: "text", text: "User rule", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);
    // §J unified rules (2026-10-27): block 2 must only OPEN with the full
    // stable text and block 3 is unconstrained — C1 puts the client text in
    // block 3 so block 2 stays byte-exact pure stable.
    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[0]).toEqual({ type: "text", text: "You are ZCode, an interactive agent" });
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[1].text).toContain("working with the user toward their goals");
    expect(parsed.system[1].text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    expect(parsed.system[1].text).not.toContain("User rule");
    expect(parsed.system[2].text).toBe("\n\nUser rule");
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("system blocks stay env-free regardless of body.model presence (3.17.1 meta_user move)", () => {
    for (const model of [undefined, "", { nested: "object" }]) {
      const body = JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      });

      const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
      const parsed = JSON.parse(out as string);

      expect(parsed.system).toHaveLength(3);
      expect(parsed.system[2].text).toBe("");
      expect(parsed.system[2].text).not.toContain("You have been invoked in the following environment:");
      expect(parsed.system[2].text).not.toContain("powered by the model named");
    }
  });

  it("string client system becomes block 3 (C1, 3-block shape)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      system: "User rule",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "anthropic", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.system).toHaveLength(3);
    expect(parsed.system[1].text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    expect(parsed.system[1].text).not.toContain("User rule");
    expect(parsed.system[2].text).toBe("\n\nUser rule");
  });
});

describe("transformRequestBody — start-plan system (OpenAI)", () => {
  it("prepends the three ZCode system messages (minimal: empty third) before OpenAI chat messages", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "openai", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: "You are ZCode, an interactive agent",
    });
    expect(parsed.messages[1].role).toBe("system");
    expect(parsed.messages[1].content).toContain("# Harness");
    // Desktop Context deliberately not injected (CLI-face state, NOTEPAD §J)
    expect(parsed.messages[1].content).not.toContain("# ZCode Desktop Context");
    expect(parsed.messages[2].role).toBe("system");
    // 3.17.1: Environment Info / powered-by live in meta_user attachments,
    // and block 3 is EMPTY on the default path (minimal-set anchoring).
    expect(parsed.messages[2].content).toBe("");
    expect(parsed.messages[2].content).not.toContain("powered by the model named");
    expect(parsed.messages[3]).toEqual({ role: "user", content: "hi" });
  });

  it("OpenAI system messages stay env-free when body.model is missing", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });

    const out = withEnvPromptVars(() => transformRequestBody(body, { format: "openai", startPlan: true, provider: "bigmodel" }));
    const parsed = JSON.parse(out as string);

    expect(parsed.messages[0].role).toBe("system");
    expect(parsed.messages[2].role).toBe("system");
    expect(parsed.messages[2].content).toBe("");
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
