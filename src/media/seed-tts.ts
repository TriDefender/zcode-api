/**
 * Seed-Audio-compatible speech synthesis face (`POST /api/v3/tts/create`) →
 * video_edit MCP `speech_synthesize` translation.
 *
 * Shapes follow the plugin's tts.py (the kit's official-dialect client):
 *   body {model, text_prompt, audio_config{format, sample_rate, pitch_rate,
 *   speech_rate, loudness_rate, enable_subtitle?}, watermark:{},
 *   references?:[{speaker}]}
 *   → response {code: 0, data: <base64 audio>, duration?, original_duration?,
 *   subtitle?}.
 *
 * Defaults mirror the kit: format "mp3", sample_rate 48000, neutral rates 0.
 * `watermark` and `enable_subtitle` are accepted and IGNORED (no ToolHub/
 * video_edit counterpart) — deliberate deviation. All 11
 * SpeechSynthesizeRequest fields are required server-side (zcode-server
 * dropped every `omitempty`), so the outgoing payload is filled completely.
 *
 * @see src/media/video-edit.ts（video_edit 调用契约）
 */
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";
import { VideoEditClient } from "./video-edit.js";

export interface SeedTtsRequest {
  model: string;
  text: string;
  outputFormat: string;
  sampleRate: number;
  speechRate: number;
  pitchRate: number;
  loudnessRate: number;
  voice?: string;
}

const OUTPUT_FORMATS = new Set(["wav", "mp3", "ogg_opus"]);
const SAMPLE_RATES = new Set([8000, 16000, 24000, 32000, 44100, 48000]);

function intInRange(raw: unknown, min: number, max: number, name: string): { ok: true; value?: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return { ok: false, message: `${name} must be an integer in [${min}, ${max}]` };
  }
  return { ok: true, value: raw };
}

/** Parse + validate the official-shaped create body. Pure — direct-tested. */
export function parseTtsCreateRequest(body: unknown): { ok: true; req: SeedTtsRequest } | { ok: false; kind: MediaUpstreamKind; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, kind: "param", message: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const text = typeof raw.text_prompt === "string" ? raw.text_prompt.trim() : "";
  if (!text) {
    return { ok: false, kind: "param", message: "text_prompt is required and must be a non-empty string" };
  }
  // model 可缺省：kit 在 ZCode 通道下发的就是空串（zcode_official_speech_synthesize
  // 的 `model=str(args.get("model") or "")`）——video_edit 的 required 是字段在场
  // 而非非空，服务端有自己的默认模型。本地强制 model 反而是镜像偏差（review P3-7
  // 的原始假设"空 model 会撞网关"不成立，2026-11-14 修正）。

  const references = Array.isArray(raw.references) ? raw.references : [];
  // 与 image 面同一口径：多 voice 引用上游（kit）只消费一个，静默丢弃不如响亮拒绝。
  if (references.length > 1) {
    return { ok: false, kind: "param", message: "at most one voice reference is supported (references[0].speaker)" };
  }
  const firstReference = references.find((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
  const voice = typeof firstReference?.speaker === "string" && firstReference.speaker.trim() ? firstReference.speaker.trim() : undefined;

  const config = raw.audio_config && typeof raw.audio_config === "object" && !Array.isArray(raw.audio_config)
    ? (raw.audio_config as Record<string, unknown>)
    : {};

  const format = typeof config.format === "string" && config.format.trim() ? config.format.trim() : "mp3";
  if (!OUTPUT_FORMATS.has(format)) {
    return { ok: false, kind: "param", message: `audio_config.format must be one of ${[...OUTPUT_FORMATS].join(" / ")}` };
  }

  let sampleRate = 48000;
  if (config.sample_rate !== undefined && config.sample_rate !== null) {
    if (typeof config.sample_rate !== "number" || !Number.isInteger(config.sample_rate) || !SAMPLE_RATES.has(config.sample_rate)) {
      return { ok: false, kind: "param", message: `audio_config.sample_rate must be one of ${[...SAMPLE_RATES].sort((a, b) => a - b).join(" / ")}` };
    }
    sampleRate = config.sample_rate;
  }

  const pitch = intInRange(config.pitch_rate, -12, 12, "audio_config.pitch_rate");
  if (!pitch.ok) return { ok: false, kind: "param", message: pitch.message };
  const speech = intInRange(config.speech_rate, -50, 100, "audio_config.speech_rate");
  if (!speech.ok) return { ok: false, kind: "param", message: speech.message };
  const loudness = intInRange(config.loudness_rate, -50, 100, "audio_config.loudness_rate");
  if (!loudness.ok) return { ok: false, kind: "param", message: loudness.message };

  return {
    ok: true,
    req: {
      // 实弹证据（2026-11-14 探针矩阵，经 /mcp tools/call）：model="" voice="" → 成功
      // 返回 MP3；model="bigmodel"/"seed-tts-2" → internal_error；voice 非默认音色 →
      // internal_error。服务端自选上游模型，转发客户端的 Volcano 风格 model 只会炸——
      // 一律转发 ""（deliberate deviation，入站 model 接受并忽略）。
      model: "",
      text,
      outputFormat: format,
      sampleRate,
      speechRate: speech.value ?? 0,
      pitchRate: pitch.value ?? 0,
      loudnessRate: loudness.value ?? 0,
      ...(voice ? { voice } : {}),
    },
  };
}

/** All 11 SpeechSynthesizeRequest fields, zero-values included. Pure — direct-tested. */
export function buildSynthesizeArguments(req: SeedTtsRequest): Record<string, unknown> {
  return {
    text: req.text,
    output_format: req.outputFormat,
    voice: req.voice ?? "",
    speed: 0,
    speech_rate: req.speechRate,
    pitch_rate: req.pitchRate,
    loudness_rate: req.loudnessRate,
    sample_rate: req.sampleRate,
    model: req.model,
    style_instructions: "",
    sample_mode: false,
  };
}

export interface SeedTtsResponse {
  code: number;
  message?: string;
  data: string;
  duration?: number;
  original_duration?: number;
  subtitle?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

/** Map the video_edit structured response onto the official create shape. Pure — direct-tested. */
export function mapSynthesizeResponse(data: Record<string, unknown>): SeedTtsResponse {
  const audio = typeof data.audio_base64 === "string" && data.audio_base64.trim() ? data.audio_base64 : undefined;
  if (!audio) {
    throw new MediaUpstreamError("speech_synthesize returned no audio_base64", "upstream");
  }
  const out: SeedTtsResponse = { code: 0, data: audio };
  if (typeof data.duration === "number") out.duration = data.duration;
  if (typeof data.original_duration === "number") out.original_duration = data.original_duration;
  if (data.subtitle && typeof data.subtitle === "object" && !Array.isArray(data.subtitle)) {
    out.subtitle = data.subtitle as Record<string, unknown>;
  }
  if (data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)) {
    out.usage = data.usage as Record<string, unknown>;
  }
  return out;
}

/** One blocking synthesis call (kit cloud_tts budget: 300s). */
export async function synthesizeSpeech(client: VideoEditClient, req: SeedTtsRequest): Promise<SeedTtsResponse> {
  const { data } = await client.callTool("speech_synthesize", buildSynthesizeArguments(req), 300_000);
  return mapSynthesizeResponse(data);
}
