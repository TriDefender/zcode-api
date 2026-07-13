/**
 * Media sanitizer — strips image content blocks before forwarding to upstreams
 * that reject non-text blocks.
 *
 * Z.AI / Bigmodel GLM coding-plan models reply with
 * `{"error":{"code":"1210","message":"messages.content.type 参数非法，取值范围 ['text']"}}`
 * when a request carries an `image_url` content part, because the text-only
 * chat endpoint only accepts `text` blocks. Mirrors cc-switch's
 * `src-tauri/src/proxy/media_sanitizer.rs` two-tier strategy:
 *
 *   1. **Prevention** — for known text-only models, replace image blocks with a
 *      text marker before the request leaves the proxy.
 *   2. **Reactive fallback** — when the upstream returns an "unsupported image"
 *      error anyway, unconditionally strip image blocks and retry once.
 *
 * Operates on the translated OpenAI-format body: by the time this runs, both
 * Anthropic clients (whose `image` blocks the translator turns into
 * `image_url`) and OpenAI clients carry image input as `{type:"image_url"}`.
 */
export const UNSUPPORTED_IMAGE_MARKER = "[Unsupported Image]";

/** Status codes that upstreams use to signal "I cannot handle this media". */
const UNSUPPORTED_MEDIA_STATUSES = new Set([400, 415, 422, 501]);

/**
 * GLM vision models carry a trailing `v` after the version digit
 * (e.g. `glm-4.6v`, `glm-5v-turbo`). Everything else in the Z.AI / Bigmodel
 * catalog is text-only.
 */
const VISION_MODEL_PATTERN = /\d+v(?:\b|-)/i;

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

/**
 * Whether a parsed OpenAI Chat body carries any `image_url` content blocks.
 * Descends into nested `content` arrays so images embedded inside tool-result
 * blocks are also detected.
 */
export function openAIBodyContainsImage(parsed: unknown): boolean {
  const body = asObject(parsed);
  if (!body) return false;
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => contentContainsImage(asObject(message)?.content));
}

function contentContainsImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const obj = asObject(block);
    if (!obj) return false;
    if (obj.type === "image_url") return true;
    return contentContainsImage(obj.content);
  });
}

/**
 * Replace every `image_url` content block in a parsed OpenAI Chat body with a
 * text marker. A preserved `cache_control` is migrated onto the replacement so
 * prompt-cache breakpoints survive the swap. Returns the number of blocks
 * replaced; the body is mutated in place.
 */
export function replaceOpenAIImageUrlsInPlace(parsed: unknown): number {
  const body = asObject(parsed);
  if (!body) return 0;
  const messages = body.messages;
  if (!Array.isArray(messages)) return 0;
  let replaced = 0;
  for (const message of messages) {
    const obj = asObject(message);
    if (!obj) continue;
    replaced += replaceImagesInContent(obj.content);
  }
  return replaced;
}

function replaceImagesInContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let replaced = 0;
  for (const block of content) {
    const obj = asObject(block);
    if (!obj) continue;
    if (obj.type === "image_url") {
      const preservedCacheControl = obj.cache_control;
      for (const key of Object.keys(obj)) {
        if (key !== "cache_control") delete obj[key];
      }
      obj.type = "text";
      obj.text = UNSUPPORTED_IMAGE_MARKER;
      if (preservedCacheControl !== undefined) obj.cache_control = preservedCacheControl;
      replaced++;
      continue;
    }
    if (Array.isArray(obj.content)) {
      replaced += replaceImagesInContent(obj.content);
    }
  }
  return replaced;
}

/**
 * Parse an OpenAI Chat body string, strip image blocks, and re-serialize.
 * Returns `{ body, replaced }`. The original string is returned untouched
 * (same reference, `replaced: 0`) when the body is empty, unparseable, or
 * carries no image blocks — so callers can cheaply detect a no-op.
 */
export function stripImageUrlsFromOpenAIBodyString(
  body: string | undefined,
): { body: string | undefined; replaced: number } {
  if (body === undefined || body.length === 0) return { body, replaced: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, replaced: 0 };
  }
  const replaced = replaceOpenAIImageUrlsInPlace(parsed);
  if (replaced === 0) return { body, replaced: 0 };
  return { body: JSON.stringify(parsed), replaced };
}

/**
 * Whether a model id names a vision-capable GLM variant. Used to decide
 * preventive stripping — text-only models get their images replaced before the
 * first attempt so we avoid a wasted round-trip.
 */
export function modelSupportsImage(model: string | undefined): boolean {
  if (!model) return false;
  return VISION_MODEL_PATTERN.test(model);
}

/**
 * Whether a model is known to be text-only. Conservative mirror of cc-switch's
 * `known_text_only_model`: in the Z.AI / Bigmodel catalog the vision variants
 * are explicitly tagged with a trailing `v`, so anything that is not tagged is
 * treated as text-only.
 */
export function isKnownTextOnlyModel(model: string | undefined): boolean {
  if (!model) return false;
  return !modelSupportsImage(model);
}

/**
 * Detect whether an upstream error body is an "unsupported image / non-text
 * content" rejection. Recognises Z.AI / Bigmodel's `code:1210` Chinese error
 * as well as the English phrasings other compatible upstreams emit.
 */
export function isUnsupportedImageError(status: number, errBody: string): boolean {
  if (!UNSUPPORTED_MEDIA_STATUSES.has(status)) return false;

  let message = "";
  let code = "";
  try {
    const parsed = JSON.parse(errBody) as unknown;
    const obj = asObject(parsed);
    const errObj = asObject(obj?.error) ?? obj;
    const rawMessage = errObj?.message ?? obj?.message ?? "";
    message = typeof rawMessage === "string" ? rawMessage : String(rawMessage ?? "");
    const rawCode = errObj?.code ?? obj?.code;
    code = typeof rawCode === "string" ? rawCode : "";
  } catch {
    message = errBody ?? "";
  }

  // Z.AI / Bigmodel GLM: code 1210 — content type rejected by text-only model.
  if (code === "1210") return true;

  const lower = message.toLowerCase();

  // "messages.content.type ... ['text']" / "unknown variant `image_url`, expected `text`"
  if (/content[._]type/.test(message) && lower.includes("text")) return true;
  if (lower.includes("image_url") && lower.includes("text")) return true;
  if (lower.includes("unknown variant") && lower.includes("text")) return true;

  // English phrasings: "image ... unsupported / not supported / text only / ..."
  const mentionsImage = [
    "image",
    "vision",
    "multimodal",
    "multi-modal",
    "modality",
    "modalities",
    "media",
    "attachment",
  ].some((keyword) => lower.includes(keyword));
  if (mentionsImage) {
    const unsupportedHints = [
      "unsupported",
      "not supported",
      "does not support",
      "doesn't support",
      "do not support",
      "don't support",
      "only supports text",
      "text only",
      "text-only",
      "invalid content type",
      "invalid message content",
      "unknown content type",
      "unrecognized content type",
      "cannot process",
      "cannot handle",
      "can't process",
      "can't handle",
      "unable to process",
    ];
    if (unsupportedHints.some((hint) => lower.includes(hint))) return true;
  }

  // Chinese phrasings: "不支持...图片/图像/视觉/image"
  if (/不支持.{0,8}(图片|图像|视觉|image)/i.test(message)) return true;
  if (/(图片|图像|视觉).{0,8}不支持/.test(message)) return true;

  return false;
}
