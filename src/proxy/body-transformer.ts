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
 *   3. Anthropic format → clear existing `cache_control` markers on all
 *      non-system messages, then add `{ type: "ephemeral" }` to the last
 *      content block of the last non-system message (mirrors the bundle's
 *      `zsi`+`Fsi` pair). Anthropic's API silently ignores `cache_control`
 *      below the per-model token floor, so unconditional marking is safe and
 *      matches ZCode's `applyCacheControl: true` default.
 *   4. Anthropic format + `ctx.metadataUserId` set → inject
 *      `metadata: { user_id }` (bundle `E2e`/`UIo` device/session blob —
 *      value assembled by the caller via buildAnthropicMetadataUserId).
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { buildStartPlanSystem, buildContextPrefixMessage } from "./system-prompt.js";
import { resolveEnvPromptInfo } from "./identity.js";

interface TransformContext {
  format: Format;
  /**
   * When set, the Anthropic-format body gets `metadata.user_id` injected.
   * Callers pass the bundle's device/session blob (see
   * buildAnthropicMetadataUserId in trace-headers.ts) — real traffic never
   * carries the account uuid here (account_uuid is hardcoded "" upstream).
   */
  metadataUserId?: string;
  /** When true (start-plan), prepend ZCode gateway system blocks. */
  startPlan?: boolean;
  /**
   * Active upstream provider — feeds the powered-by line's `{providerId}/`
   * prefix (bundle `p2`: zai→"zai-api", bigmodel→"bigmodel-api"). Always set
   * by production callers alongside `startPlan`.
   */
  provider?: "zai" | "bigmodel";
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
      modified = applyStartPlanOpenAISystem(parsed as Record<string, unknown>, ctx.provider) || modified;
    }
    modified = applyStreamOptionsIncludeUsage(parsed as Record<string, unknown>) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed as Record<string, unknown>;
    if (ctx.startPlan) {
      modified = applyStartPlanSystem(obj, ctx.provider) || modified;
    }
    modified = applyAnthropicCacheControl(obj) || modified;
    if (ctx.metadataUserId) {
      modified = applyAnthropicUserId(obj, ctx.metadataUserId) || modified;
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
 * Anthropic: two-phase cache_control injection, mirroring the bundle's
 * `zsi` (clear) + `Fsi` (mark) pair:
 *   (1) strip `cache_control` from every content block of every NON-system
 *       message (string content carries no marker to clear);
 *   (2) mark the last content block of the LAST non-system message (existing
 *       location algorithm) with `{type: "ephemeral"}`; string content is
 *       converted to a block array first (kept from the previous behavior).
 *
 * Without the clear phase, client-supplied `cache_control` on earlier messages
 * would pass through alongside our marker → multiple cache breakpoints and
 * more cache writes than the real client produces. The top-level `system`
 * field is untouched. The bundle's skipCacheWrite variant (marks the
 * second-to-last message instead) is NOT implemented — this proxy always
 * writes cache.
 *
 * Output-stable: applying this to an already-canonical body yields the same
 * bytes (no duplicate markers, target block unchanged). Note the function
 * still reports `modified` in that case — the clear phase strips the target
 * block's own marker before phase 2 re-adds the identical one — so callers
 * re-serialize once more; harmless (byte-identical output), just not free.
 */
function applyAnthropicCacheControl(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // Phase 1 (bundle `zsi`): clear stale markers on non-system messages.
  let cleaned = false;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block === "object" && block !== null && "cache_control" in block) {
        delete block.cache_control;
        cleaned = true;
      }
    }
  }

  // Phase 2 (bundle `Fsi`): mark the last non-system message's last block.
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
      // Already marked — only report modified if the clear phase stripped
      // stray markers elsewhere (idempotency: avoid needless re-serialize).
      return cleaned;
    }
    return cleaned;
  }
  return cleaned;
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
 * start-plan: prepend ZCode gateway system blocks (ContextBuilder mirror —
 * see system-prompt.ts). The gateway rejects requests without these identity
 * blocks with 3012 "method not allowed". Forwards `body.model` so
 * `buildStartPlanSystem` can emit the dynamic "You are powered by the model
 * named ${model}." line inside the Environment section, and attaches the
 * meta_user context_prefix (currentDate `<system-reminder>` user turn) that
 * every real client request carries. Client `cache_control` on tools is
 * stripped: official blocks (3) + last-message marker (1) already fill
 * Anthropic's 4-breakpoint cache budget.
 */
function applyStartPlanSystem(body: Record<string, unknown>, provider?: "zai" | "bigmodel"): boolean {
  const model = typeof body.model === "string" ? body.model : undefined;
  body.system = buildStartPlanSystem(body.system, model, resolveEnvPromptInfo(), provider);
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    body.messages = [buildContextPrefixMessage() as unknown, ...body.messages];
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (typeof tool === "object" && tool !== null && "cache_control" in tool) {
        delete (tool as Record<string, unknown>).cache_control;
      }
    }
  }
  return true;
}

function applyStartPlanOpenAISystem(body: Record<string, unknown>, provider?: "zai" | "bigmodel"): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  const model = typeof body.model === "string" ? body.model : undefined;
  const official = buildStartPlanSystem(undefined, model, resolveEnvPromptInfo(), provider).map((block) => ({
    role: "system",
    content: typeof block === "object" && block !== null && "text" in block ? String(block.text) : "",
  }));
  body.messages = [...official, ...messages];
  return true;
}
