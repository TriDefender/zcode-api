/**
 * Seed-family mapping tests: the Ark-shape parsers and the outgoing ToolHub /
 * video_edit payload builders are the compatibility contract — pin every
 * mapping rule, including the accepted-but-ignored deviations and the
 * negative suppressions (body must NOT contain what the caller must not
 * reach upstream with).
 */
import { describe, it, expect } from "bun:test";
import { OFFICIAL_MCP_CATALOGUE } from "../mcp/catalogue.js";
import { parseSeedImageRequest, generateImage } from "./seed-image.js";
import {
  buildToolhubVideoBody,
  createVideoTask,
  mapVideoTaskSnapshot,
  parseSeedVideoCreateRequest,
  validateVideoMaterialUrls,
} from "./seed-video.js";
import { buildTranscribeArguments, mapTranscriptToFlash, parseAsrFlashRequest } from "./seed-asr.js";
import { buildSynthesizeArguments, mapSynthesizeResponse, parseTtsCreateRequest } from "./seed-tts.js";
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";
import type { ToolHubDeps } from "./toolhub.js";

const okParse = <T>(result: { ok: true; req: T } | { ok: false; kind: MediaUpstreamKind; message: string }): T => {
  if (!result.ok) throw new Error(`expected ok parse, got: ${result.message}`);
  return result.req;
};

const errParse = (result: { ok: true } | { ok: false; kind: MediaUpstreamKind; message: string }): { kind: MediaUpstreamKind; message: string } => {
  if (result.ok) throw new Error("expected error parse");
  return { kind: result.kind, message: result.message };
};

describe("official-catalogue — video_edit manual entry", () => {
  it("exposes the video_edit route through the /mcp aggregate", () => {
    const entry = OFFICIAL_MCP_CATALOGUE.servers.find((s) => s.routeId === "video_edit");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("video-edit");
    expect(entry!.plugin).toBe("video-agent-kit");
    expect(entry!.path).toBe("/api/v1/mcp/server/video_edit");
    expect(entry!.requiresPaidPlan).toBe(true);
  });
});

describe("parseSeedImageRequest", () => {
  it("parses prompt + single https reference", () => {
    const req = okParse(parseSeedImageRequest({ model: "doubao-seedream-4-0-250828", prompt: "a cat", image: "https://r.test/a.png" }));
    expect(req.prompt).toBe("a cat");
    expect(req.image).toBe("https://r.test/a.png");
    expect(req.model).toBe("doubao-seedream-4-0-250828");
    expect(req.responseFormat).toBe("url");
  });

  it("accepts a single-element image array, rejects multi-element arrays honestly", () => {
    expect(okParse(parseSeedImageRequest({ prompt: "x", image: ["https://r.test/a.png"] })).image).toBe("https://r.test/a.png");
    const err = errParse(parseSeedImageRequest({ prompt: "x", image: ["https://a", "https://b"] }));
    expect(err.kind).toBe("param");
    expect(err.message).toContain("single reference image");
  });

  it("rejects empty prompt and bad response_format", () => {
    expect(errParse(parseSeedImageRequest({ prompt: "" })).kind).toBe("param");
    expect(errParse(parseSeedImageRequest({ prompt: "x", response_format: "b64" })).kind).toBe("param");
  });

  it("accepts b64_json", () => {
    expect(okParse(parseSeedImageRequest({ prompt: "x", response_format: "b64_json" })).responseFormat).toBe("b64_json");
  });
});

describe("generateImage — orchestration", () => {
  function stubToolhub(handlers: Array<(call: { url: string; body: string | FormData }) => Response>) {
    const calls: Array<{ url: string; body: string | FormData; headers: Record<string, string> }> = [];
    let n = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const call = { url: String(input), body: (init?.body as string | FormData) ?? "", headers: Object.fromEntries(new Headers(init?.headers).entries()) };
      calls.push(call);
      const handler = handlers[Math.min(n, handlers.length - 1)];
      n += 1;
      return handler(call);
    }) as unknown as typeof fetch;
    const deps: ToolHubDeps = { origin: "https://zcode.test", headers: { Authorization: "Bearer jwt" }, fetchImpl: impl, retryDelayMs: 1 };
    return { deps, calls };
  }

  const invokeOk = () => new Response(JSON.stringify({ code: 0, data: { state: "SUCCEEDED", output: { image_url: "https://img.test/out.png" } } }), { headers: { "content-type": "application/json" } });

  it("passes https references through WITHOUT an upload round-trip", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    const result = await generateImage(deps, deps.fetchImpl, okParse(parseSeedImageRequest({ prompt: "a cat", image: "https://r.test/a.png" })));
    expect(result.data[0]).toEqual({ url: "https://img.test/out.png" });
    expect(result.usage).toEqual({ generated_images: 1 });
    expect(result.model).toBe("doubao-seedream");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/api/v1/toolhub/tool/image_generate/invoke");
    const body = JSON.parse(calls[0].body as string) as { query: string; image?: string };
    expect(body.image).toBe("https://r.test/a.png");
  });

  it("uploads a data: reference first, then invokes with the presigned url", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const { deps, calls } = stubToolhub([
      () => new Response(JSON.stringify({ code: 0, data: { url: "https://files.test/ref.png" } }), { headers: { "content-type": "application/json" } }),
      invokeOk,
    ]);
    const result = await generateImage(deps, deps.fetchImpl, okParse(parseSeedImageRequest({ prompt: "a cat", image: `data:image/png;base64,${png}` })));
    expect(result.data[0]).toEqual({ url: "https://img.test/out.png" });
    expect(calls[0].url).toContain("/api/v1/toolhub/files");
    expect(calls[0].body instanceof FormData).toBe(true);
    const invokeBody = JSON.parse(calls[1].body as string) as { image?: string };
    expect(invokeBody.image).toBe("https://files.test/ref.png");
  });

  it("returns b64_json by downloading the generated image", async () => {
    const { deps } = stubToolhub([invokeOk]);
    const downloader = (async (input: RequestInfo | URL): Promise<Response> => {
      expect(String(input)).toBe("https://img.test/out.png");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await generateImage(deps, downloader, okParse(parseSeedImageRequest({ prompt: "a cat", response_format: "b64_json" })));
    expect((result.data[0] as { b64_json: string }).b64_json).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("rejects non-https non-data references before any upstream call", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    await expect(generateImage(deps, deps.fetchImpl, okParse(parseSeedImageRequest({ prompt: "x", image: "http://r.test/a.png" })))).rejects.toThrow(/https/);
    expect(calls.length).toBe(0);
  });

  it("rejects non-standard base64 data: references before any upstream call (mirror of the plugin's strict check)", async () => {
    const { deps, calls } = stubToolhub([invokeOk]);
    const bad = [
      "data:image/png;base64,AA-A", // URL-safe alphabet char
      "data:image/png;base64,A", // length % 4 == 1
      "data:image/png;base64,QUJD=", // non-canonical padding on a full group
      "data:image/png;base64,QU%2BD", // percent-encoded
    ];
    for (const image of bad) {
      await expect(generateImage(deps, deps.fetchImpl, okParse(parseSeedImageRequest({ prompt: "x", image })))).rejects.toThrow(/standard base64/);
    }
    expect(calls.length).toBe(0);
  });
});

describe("parseSeedVideoCreateRequest", () => {
  it("routes content roles onto ToolHub params (reference materials)", () => {
    const req = okParse(parseSeedVideoCreateRequest({
      model: "doubao-seedance-2-5-260628",
      content: [
        { type: "text", text: "drone over a forest" },
        { type: "image_url", image_url: { url: "https://r.test/ref.png" } },
        { type: "video_url", video_url: { url: "asset://v1" } },
        { type: "audio_url", audio_url: { url: "https://r.test/a.mp3" } },
      ],
      duration: 5,
      ratio: "16:9",
    }));
    expect(req.prompt).toBe("drone over a forest");
    expect(req.images).toEqual(["https://r.test/ref.png"]);
    expect(req.videos).toEqual(["asset://v1"]);
    expect(req.audios).toEqual(["https://r.test/a.mp3"]);
    expect(req.duration).toBe(5);
    expect(req.ratio).toBe("16:9");
    expect(req.firstFrame).toBeUndefined();
    expect(req.lastFrame).toBeUndefined();
  });

  it("routes explicit first/last_frame roles (no reference materials — ToolHub exclusivity)", () => {
    const req = okParse(parseSeedVideoCreateRequest({
      content: [
        { type: "text", text: "morph" },
        { type: "image_url", image_url: { url: "https://r.test/first.png" }, role: "first_frame" },
        { type: "image_url", image_url: { url: "https://r.test/last.png" }, role: "last_frame" },
      ],
      ratio: "adaptive",
    }));
    expect(req.firstFrame).toBe("https://r.test/first.png");
    expect(req.lastFrame).toBe("https://r.test/last.png");
    expect(req.images).toBeUndefined();
    expect(req.ratio).toBe("adaptive");
  });

  it("joins multiple text items with newline", () => {
    const req = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }));
    expect(req.prompt).toBe("a\nb");
  });

  it("defaults an omitted ratio to adaptive EXCEPT with a first_frame", () => {
    const plain = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }] }));
    expect(plain.ratio).toBe("adaptive");
    const framed = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "https://r.test/f.png" }, role: "first_frame" }] }));
    expect(framed.ratio).toBeUndefined();
  });

  it("enforces the first/last-frame exclusivity and last-without-first rules", () => {
    const mixed = errParse(parseSeedVideoCreateRequest({
      content: [
        { type: "text", text: "x" },
        { type: "image_url", image_url: { url: "https://r.test/f.png" }, role: "first_frame" },
        { type: "image_url", image_url: { url: "https://r.test/r.png" } },
      ],
    }));
    expect(mixed.kind).toBe("param");
    expect(errParse(parseSeedVideoCreateRequest({
      content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "https://r.test/l.png" }, role: "last_frame" }],
    })).message).toContain("last_frame requires a first_frame");
  });

  it("validates duration and ratio ranges", () => {
    expect(errParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }], duration: 3 })).kind).toBe("param");
    expect(errParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }], duration: 31 })).kind).toBe("param");
    expect(okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }], duration: -1 })).duration).toBe(-1);
    expect(errParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }], ratio: "21:10" })).kind).toBe("param");
  });

  it("rejects empty content and unknown types", () => {
    expect(errParse(parseSeedVideoCreateRequest({ content: [] })).kind).toBe("param");
    expect(errParse(parseSeedVideoCreateRequest({})).kind).toBe("param");
    expect(errParse(parseSeedVideoCreateRequest({ content: [{ type: "ppt" }] })).kind).toBe("param");
  });
});

describe("seed-video — outgoing body + validation + mapping", () => {
  it("buildToolhubVideoBody mirrors buildSubmitBody field-for-field", () => {
    const req = okParse(parseSeedVideoCreateRequest({
      content: [
        { type: "text", text: "x" },
        { type: "image_url", image_url: { url: "https://r.test/a.png" } },
        { type: "video_url", video_url: { url: "asset://v" } },
      ],
      duration: 8,
    }));
    const body = buildToolhubVideoBody(req);
    expect(body).toEqual({ query: "x", duration: 8, ratio: "adaptive", images: ["https://r.test/a.png"], videos: ["asset://v"] });
  });

  it("validateVideoMaterialUrls rejects data:/http: videos and oversized inline audio", () => {
    const badVideo = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }, { type: "video_url", video_url: { url: "data:video/mp4;base64,AAA" } }] }));
    expect(validateVideoMaterialUrls(badVideo)).toEqual({ ok: false, message: expect.stringContaining("https:// or asset://") });
    const bigAudio = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }, { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${"A".repeat(3 * 1024 * 1024)}` } }] }));
    expect(validateVideoMaterialUrls(bigAudio).ok).toBe(false);
    const good = okParse(parseSeedVideoCreateRequest({ content: [{ type: "text", text: "x" }, { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${"A".repeat(64)}` } }] }));
    expect(validateVideoMaterialUrls(good).ok).toBe(true);
  });

  it("mapVideoTaskSnapshot: succeeded/failed/unknown→running", () => {
    expect(mapVideoTaskSnapshot("t", { status: "succeeded", videoUrl: "https://v.test/a.mp4" })).toEqual({ id: "t", status: "succeeded", content: { video_url: "https://v.test/a.mp4" } });
    const failed = mapVideoTaskSnapshot("t", { status: "failed", failure: { code: "X", message: "no" } });
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "X", message: "no" });
    expect(mapVideoTaskSnapshot("t", { status: "processing" }).status).toBe("running");
    expect(mapVideoTaskSnapshot("t", { status: "unknown" }).status).toBe("running");
  });

  it("createVideoTask submits and echoes the model", async () => {
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toContain("/api/v1/toolhub/tool/video_generate/invoke");
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).toBe("x");
      return new Response(JSON.stringify({ code: 0, data: { state: "SUCCEEDED", output: { task_id: "task-7" } } }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const deps: ToolHubDeps = { origin: "https://zcode.test", headers: {}, fetchImpl: impl, retryDelayMs: 1 };
    const req = okParse(parseSeedVideoCreateRequest({ model: "doubao-seedance-2-0-260128", content: [{ type: "text", text: "x" }] }));
    expect(await createVideoTask(deps, req)).toEqual({ id: "task-7", model: "doubao-seedance-2-0-260128", status: "queued" });
  });
});

describe("seed-asr — flash mapping", () => {
  it("parses audio.data/format/language and ignores user/request", () => {
    const req = okParse(parseAsrFlashRequest({ user: { uid: "u" }, audio: { data: "QUJD", format: "mp3", language: "zh-CN" }, request: { model_name: "bigmodel", enable_itn: true } }));
    expect(req).toEqual({ audioBase64: "QUJD", audioFormat: "mp3", language: "zh-CN" });
    expect(errParse(parseAsrFlashRequest({ audio: { format: "mp3" } })).message).toContain("audio.data");
    expect(errParse(parseAsrFlashRequest({ audio: { data: "QUJD" } })).message).toContain("audio.format");
  });

  it("buildTranscribeArguments fills ALL 8 required fields (server dropped omitempty)", () => {
    const args = buildTranscribeArguments({ audioBase64: "QUJD", audioFormat: "wav", language: "en-US" });
    expect(Object.keys(args).sort()).toEqual([
      "audio_base64", "chunk_seconds", "input_format", "input_path", "language", "retries", "retry_backoff_seconds", "timeout_seconds",
    ]);
    expect(args).toEqual({
      audio_base64: "QUJD",
      input_format: "wav",
      input_path: "",
      language: "en-US",
      timeout_seconds: 0,
      chunk_seconds: 0,
      retries: 0,
      retry_backoff_seconds: 0,
    });
  });

  it("mapTranscriptToFlash converts seconds→ms and threads speakers through additions", () => {
    const mapped = mapTranscriptToFlash({
      transcript: {
        text: "你好",
        audio_duration_seconds: 1.5,
        segments: [
          { speaker: "1", text: "你好", start: 0.1, end: 0.9, words: [{ text: "你", start: 0.1, end: 0.5 }, { text: "好", start: 0.5, end: 0.9 }] },
        ],
      },
      usage: { seconds: 2 },
    });
    expect(mapped.silent).toBeUndefined();
    expect(mapped.response!.result.text).toBe("你好");
    expect(mapped.response!.audio_info).toEqual({ duration: 1500 });
    const u = mapped.response!.result.utterances[0];
    expect(u.start_time).toBe(100);
    expect(u.end_time).toBe(900);
    expect(u.additions).toEqual({ speaker: "1" });
    expect(u.words).toEqual([{ text: "你", start_time: 100, end_time: 500 }, { text: "好", start_time: 500, end_time: 900 }]);
  });

  it("reports silent audio instead of an empty transcript", () => {
    expect(mapTranscriptToFlash({ silent_audio: true }).silent).toBe(true);
  });
});

describe("seed-tts — create mapping", () => {
  it("parses defaults (mp3/48000/neutral rates) and the voice reference", () => {
    const req = okParse(parseTtsCreateRequest({ model: "seed-tts-2", text_prompt: "你好", references: [{ speaker: "zh_female_1" }] }));
    expect(req.outputFormat).toBe("mp3");
    expect(req.sampleRate).toBe(48000);
    expect(req.speechRate).toBe(0);
    expect(req.pitchRate).toBe(0);
    expect(req.loudnessRate).toBe(0);
    expect(req.voice).toBe("zh_female_1");
  });

  it("validates ranges and formats", () => {
    expect(errParse(parseTtsCreateRequest({ text_prompt: "" })).kind).toBe("param");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { format: "flac" } })).message).toContain("format");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { sample_rate: 11025 } })).message).toContain("sample_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { pitch_rate: 13 } })).message).toContain("pitch_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { speech_rate: 101 } })).message).toContain("speech_rate");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { loudness_rate: -51 } })).message).toContain("loudness_rate");
    expect(okParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", audio_config: { format: "ogg_opus", sample_rate: 24000, speech_rate: 50, pitch_rate: -12, loudness_rate: 100 } })).outputFormat).toBe("ogg_opus");
  });

  it("rewrites the client model to \"\" on the proxy side (video_edit only accepts empty) and rejects >1 voice references", () => {
    const noModel = okParse(parseTtsCreateRequest({ text_prompt: "x" }));
    expect(noModel.model).toBe("");
    // 实弹 2026-11-14：任何非空 model（"bigmodel"/"seed-tts-2"）→ upstream internal_error——
    // 无论用户带什么 model 来，出线一律改写成空串。
    const anyModel = okParse(parseTtsCreateRequest({ model: "seed-tts-2", text_prompt: "x" }));
    expect(anyModel.model).toBe("");
    expect(errParse(parseTtsCreateRequest({ model: "m", text_prompt: "x", references: [{ speaker: "a" }, { speaker: "b" }] })).message).toContain("one voice reference");
  });

  it("buildSynthesizeArguments fills ALL 11 required fields, zero-values included", () => {
    const args = buildSynthesizeArguments({ model: "m", text: "hi", outputFormat: "mp3", sampleRate: 48000, speechRate: 10, pitchRate: -3, loudnessRate: 0 });
    expect(Object.keys(args).sort()).toEqual([
      "loudness_rate", "model", "output_format", "pitch_rate", "sample_mode", "sample_rate", "speech_rate", "speed", "style_instructions", "text", "voice",
    ]);
    expect(args.voice).toBe("");
    expect(args.speed).toBe(0);
    expect(args.style_instructions).toBe("");
    expect(args.sample_mode).toBe(false);
  });

  it("mapSynthesizeResponse passes audio/duration/subtitle/usage through", () => {
    const out = mapSynthesizeResponse({ audio_base64: "AAA=", duration: 2.5, subtitle: { words: [] }, usage: { chars: 2 } });
    expect(out).toEqual({ code: 0, data: "AAA=", duration: 2.5, subtitle: { words: [] }, usage: { chars: 2 } });
    let err: unknown;
    try {
      mapSynthesizeResponse({});
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(MediaUpstreamError);
    expect((err as MediaUpstreamError).kind).toBe("upstream");
  });
});
