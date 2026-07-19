/**
 * Request body transformer — applies ZCode-equivalent body mutations before
 * forwarding upstream. All transformations are no-ops on parse failure (the
 * original body is returned unchanged) so a malformed body never breaks the
 * proxy: it just loses the optimization.
 *
 * Transformations applied:
 *   1. OpenAI + `stream: true` → inject `stream_options.include_usage: true`
 *      (matches `@ai-sdk/openai-compatible` default in `_reverse/zcode.cjs`).
 *   2. start-plan → prepend ZCode gateway system blocks. OpenAI upstream gets
 *      system messages; Anthropic-shaped input gets the Anthropic `system` field.
 *   3. Anthropic format → add `cache_control: { type: "ephemeral" }` to the
 *      last non-system message (mirrors `HLr` ("finalizeLatestNonSystemCacheControl")
 *      at offset ~636888 in the bundle). Anthropic's API silently ignores
 *      `cache_control` below the per-model token floor, so unconditional add
 *      is safe and matches ZCode's `applyCacheControl: true` default.
 *   4. Anthropic format + `ctx.userId` set → inject `metadata: { user_id }`.
 *      Mirrors `user_id: B.metadata.userId` at bundle offset ~4760586.
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { buildStartPlanSystem } from "./system-prompt.js";

interface TransformContext {
  format: Format;
  /** When set (OAuth mode), the Anthropic-format body gets `metadata.user_id` injected. */
  userId?: string;
  /** When true (start-plan), prepend ZCode gateway system blocks. */
  startPlan?: boolean;
}

/**
 * Apply body transformations. Returns the original `body` string when nothing
 * changed OR when parsing failed; otherwise returns the re-serialized body.
 */
export function transformRequestBody(body: string | undefined, ctx: TransformContext): string | undefined {
  if (body === undefined || body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;

  let modified = false;

  if (ctx.format === "openai") {
    if (ctx.startPlan) {
      modified = applyStartPlanOpenAISystem(parsed as Record<string, unknown>) || modified;
    }
    modified = applyStreamOptionsIncludeUsage(parsed as Record<string, unknown>) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed as Record<string, unknown>;
    if (ctx.startPlan) {
      modified = applyStartPlanSystem(obj) || modified;
    }
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.userId) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
  }

  return modified ? JSON.stringify(parsed) : body;
}

/** OpenAI streaming: ensure `stream_options.include_usage: true`. */
function applyStreamOptionsIncludeUsage(body: Record<string, unknown>): boolean {
  if (body.stream !== true) return false;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) {
    return false;
  }
  const merged: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  merged.include_usage = true;
  body.stream_options = merged;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Anthropic: add `cache_control: { type: "ephemeral" }` to the last content
 * block of the last non-system message. Mirrors ZCode's `HLr` algorithm.
 * Idempotent — skips if any block on that message already carries cache_control.
 */
function applyAnthropicCacheControl(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;

    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (typeof lastBlock === "object" && lastBlock !== null && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Anthropic: inject `metadata: { user_id }` when not already set.
 * Preserves any existing `metadata.*` fields other than `user_id`.
 */
function applyAnthropicUserId(body: Record<string, unknown>, userId: string): boolean {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) {
    return false;
  }
  body.metadata = {
    ...(isPlainObject(existing) ? existing : {}),
    user_id: userId,
  };
  return true;
}

/**
 * start-plan: prepend ZCode gateway system blocks. The gateway rejects
 * requests without these identity blocks with 3012 "method not allowed".
 * Forwards `body.model` so `buildStartPlanSystem` can append the dynamic
 * "You are powered by the model named ${model}." block (matches bundle 3.3.6
 * `buildEnvInfoSection` behavior when `envInfo.currentModel` is set).
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  const model = typeof body.model === "string" ? body.model : undefined;
  body.system = buildStartPlanSystem(body.system, model);
  return true;
}

function applyStartPlanOpenAISystem(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  const model = typeof body.model === "string" ? body.model : undefined;
  const official = buildStartPlanSystem(undefined, model).map((block) => ({
    role: "system",
    content: typeof block === "object" && block !== null && "text" in block ? String(block.text) : "",
  }));
  body.messages = [...official, ...messages];
  return true;
}
