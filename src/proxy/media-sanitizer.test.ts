/**
 * Tests for the media sanitizer — mirrors cc-switch's
 * `src-tauri/src/proxy/media_sanitizer.rs` test cases, adapted to the
 * OpenAI-format body that zcode-api feeds into this module.
 */
import { describe, it, expect } from "bun:test";
import {
  UNSUPPORTED_IMAGE_MARKER,
  openAIBodyContainsImage,
  replaceOpenAIImageUrlsInPlace,
  stripImageUrlsFromOpenAIBodyString,
  modelSupportsImage,
  isKnownTextOnlyModel,
  isUnsupportedImageError,
} from "./media-sanitizer.js";

function imageBlock(): { type: string; image_url: { url: string }; cache_control?: unknown } {
  return { type: "image_url", image_url: { url: "data:image/png;base64,abc" } };
}

function bodyWith(messages: unknown): unknown {
  return { model: "glm-4.6", messages };
}

describe("replaceOpenAIImageUrlsInPlace", () => {
  it("replaces a single image_url block with the text marker", () => {
    const body = bodyWith([
      { role: "user", content: [{ type: "text", text: "look" }, imageBlock()] },
    ]);

    const replaced = replaceOpenAIImageUrlsInPlace(body);

    expect(replaced).toBe(1);
    const content = (body as any).messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toEqual({ type: "text", text: UNSUPPORTED_IMAGE_MARKER });
  });

  it("replaces multiple image blocks across messages", () => {
    const body = bodyWith([
      { role: "user", content: [imageBlock(), { type: "text", text: "a" }] },
      { role: "user", content: [imageBlock()] },
    ]);

    expect(replaceOpenAIImageUrlsInPlace(body)).toBe(2);
  });

  it("migrates cache_control onto the replacement text block", () => {
    const body = bodyWith([
      {
        role: "user",
        content: [{ ...imageBlock(), cache_control: { type: "ephemeral" } }],
      },
    ]);

    replaceOpenAIImageUrlsInPlace(body);
    const block = (body as any).messages[0].content[0];
    expect(block).toEqual({
      type: "text",
      text: UNSUPPORTED_IMAGE_MARKER,
      cache_control: { type: "ephemeral" },
    });
  });

  it("reaches image blocks nested inside a tool_result content array", () => {
    const body = bodyWith([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_call_id: "call_1",
            content: [imageBlock(), { type: "text", text: "ok" }],
          },
        ],
      },
    ]);

    expect(replaceOpenAIImageUrlsInPlace(body)).toBe(1);
    const nested = (body as any).messages[0].content[0].content;
    expect(nested[0]).toEqual({ type: "text", text: UNSUPPORTED_IMAGE_MARKER });
    expect(nested[1]).toEqual({ type: "text", text: "ok" });
  });

  it("returns 0 and leaves the body untouched when there is no image block", () => {
    const body = bodyWith([
      { role: "user", content: "plain string" },
      { role: "assistant", content: null },
    ]);

    expect(replaceOpenAIImageUrlsInPlace(body)).toBe(0);
  });

  it("is a no-op on bodies without a messages array", () => {
    expect(replaceOpenAIImageUrlsInPlace({ model: "glm-4.6" })).toBe(0);
    expect(replaceOpenAIImageUrlsInPlace(null)).toBe(0);
    expect(replaceOpenAIImageUrlsInPlace(undefined)).toBe(0);
  });
});

describe("openAIBodyContainsImage", () => {
  it("detects an image_url at the top level", () => {
    expect(openAIBodyContainsImage(bodyWith([
      { role: "user", content: [imageBlock()] },
    ]))).toBe(true);
  });

  it("detects an image nested in tool_result content", () => {
    expect(openAIBodyContainsImage(bodyWith([
      {
        role: "user",
        content: [{ type: "tool_result", tool_call_id: "c", content: [imageBlock()] }],
      },
    ]))).toBe(true);
  });

  it("returns false for text-only bodies", () => {
    expect(openAIBodyContainsImage(bodyWith([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]))).toBe(false);
    expect(openAIBodyContainsImage(bodyWith([
      { role: "user", content: "hi" },
    ]))).toBe(false);
  });
});

describe("stripImageUrlsFromOpenAIBodyString", () => {
  it("parses, strips, and re-serializes", () => {
    const body = JSON.stringify(bodyWith([
      { role: "user", content: [imageBlock()] },
    ]));

    const result = stripImageUrlsFromOpenAIBodyString(body);
    expect(result.replaced).toBe(1);
    const reparsed = JSON.parse(result.body!);
    expect(reparsed.messages[0].content[0]).toEqual({ type: "text", text: UNSUPPORTED_IMAGE_MARKER });
  });

  it("returns the same string reference when nothing changed", () => {
    const body = JSON.stringify(bodyWith([{ role: "user", content: "hi" }]));
    const result = stripImageUrlsFromOpenAIBodyString(body);
    expect(result.replaced).toBe(0);
    expect(result.body).toBe(body);
  });

  it("returns the original body for empty or unparseable input", () => {
    expect(stripImageUrlsFromOpenAIBodyString(undefined)).toEqual({ body: undefined, replaced: 0 });
    expect(stripImageUrlsFromOpenAIBodyString("")).toEqual({ body: "", replaced: 0 });
    expect(stripImageUrlsFromOpenAIBodyString("not json")).toEqual({ body: "not json", replaced: 0 });
  });
});

describe("modelSupportsImage / isKnownTextOnlyModel", () => {
  it("treats trailing-v GLM ids as vision models", () => {
    expect(modelSupportsImage("glm-4.6v")).toBe(true);
    expect(modelSupportsImage("glm-5v-turbo")).toBe(true);
  });

  it("treats non-v GLM ids as text-only", () => {
    expect(modelSupportsImage("glm-4.6")).toBe(false);
    expect(modelSupportsImage("glm-5")).toBe(false);
    expect(modelSupportsImage("glm-5.1")).toBe(false);
    expect(modelSupportsImage("glm-4.5-air")).toBe(false);
  });

  it("isKnownTextOnlyModel is the exact complement of modelSupportsImage", () => {
    expect(isKnownTextOnlyModel("glm-4.6")).toBe(true);
    expect(isKnownTextOnlyModel("glm-4.6v")).toBe(false);
    expect(isKnownTextOnlyModel(undefined)).toBe(false);
  });
});

describe("isUnsupportedImageError", () => {
  it("recognises the Z.AI / Bigmodel code-1210 Chinese error verbatim", () => {
    const errBody = JSON.stringify({
      error: { code: "1210", message: "messages.content.type 参数非法，取值范围 ['text']" },
    });
    expect(isUnsupportedImageError(400, errBody)).toBe(true);
  });

  it("recognises the English 'unknown variant image_url, expected text' phrasing", () => {
    const errBody = JSON.stringify({
      error: {
        message:
          "Failed to deserialize the JSON body into the target type: messages[11]: unknown variant `image_url`, expected `text`",
      },
    });
    expect(isUnsupportedImageError(400, errBody)).toBe(true);
  });

  it("recognises an explicit 'does not support image' message", () => {
    const errBody = JSON.stringify({ error: { message: "This model does not support image input" } });
    expect(isUnsupportedImageError(400, errBody)).toBe(true);
  });

  it("recognises Chinese '不支持...图片' phrasings", () => {
    const errBody = JSON.stringify({ error: { message: "该模型不支持图片输入" } });
    expect(isUnsupportedImageError(422, errBody)).toBe(true);
  });

  it("ignores non-media errors even at 400", () => {
    expect(isUnsupportedImageError(400, JSON.stringify({ error: { message: "Invalid API key" } }))).toBe(false);
    expect(isUnsupportedImageError(400, JSON.stringify({ error: { code: "other", message: "rate limited" } }))).toBe(false);
  });

  it("ignores a 200 response that merely mentions images", () => {
    expect(isUnsupportedImageError(200, JSON.stringify({ error: { message: "image unsupported" } }))).toBe(false);
  });

  it("falls back to the raw body when it is not JSON", () => {
    expect(isUnsupportedImageError(400, "image input is not supported by this model")).toBe(true);
  });
});
