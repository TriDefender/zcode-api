/**
 * Seed-ASR-compatible speech transcription face — flash sync only
 * (`POST /api/v3/auc/bigmodel/recognize/flash`) → video_edit MCP
 * `speech_transcribe` translation.
 *
 * Scope decision (2026-11-14, user-approved): sync blocking ONLY, mirroring
 * how the plugin actually works under the ZCode host — ve_tools/media.py
 * sends one blocking speech_transcribe per chunk with chunk_seconds/retries
 * = 0; there is NO async task surface behind it. The official async
 * submit/query endpoints are therefore NOT emulated (they would need an
 * in-memory task table for what is a blocking upstream); routes return 501
 * pointing callers at flash. Consumers are agents — they chunk oversized
 * audio client-side, one flash call per piece (45 MiB request-body cap = the
 * upstream nginx limit; routes enforce it with an explanatory 413).
 *
 * Request/response shapes follow the plugin's cloud_asr.py (the kit's
 * official-dialect client): `user`/`request` fields are accepted and IGNORED
 * (the upstream fixed its own model/ITN/punctuation/speaker settings);
 * status goes back in the `X-Api-Status-Code` response header
 * (20000000 ok / 20000003 silent audio), echoing `X-Api-Request-Id`.
 *
 * @see src/media/video-edit.ts（video_edit 调用契约）
 */
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";
import { VideoEditClient } from "./video-edit.js";

export interface SeedAsrFlashRequest {
  audioBase64: string;
  audioFormat: string;
  language?: string;
}

/** Parse + validate the official-shaped flash body. Pure — direct-tested. */
export function parseAsrFlashRequest(body: unknown): { ok: true; req: SeedAsrFlashRequest } | { ok: false; kind: MediaUpstreamKind; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, kind: "param", message: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const audio = raw.audio && typeof raw.audio === "object" && !Array.isArray(raw.audio) ? (raw.audio as Record<string, unknown>) : undefined;
  const data = typeof audio?.data === "string" ? audio.data.trim() : "";
  if (!data) {
    return { ok: false, kind: "param", message: "audio.data (base64) is required" };
  }
  const format = typeof audio?.format === "string" && audio.format.trim() ? audio.format.trim() : "";
  if (!format) {
    return { ok: false, kind: "param", message: "audio.format is required (raw | wav | mp3 | ogg)" };
  }
  const language = typeof audio?.language === "string" && audio.language.trim() ? audio.language.trim() : undefined;
  return {
    ok: true,
    req: { audioBase64: data, audioFormat: format, ...(language ? { language } : {}) },
  };
}

/**
 * The 8 SpeechTranscribeRequest fields are ALL required server-side (the
 * server dropped every `omitempty`); chunking/retries stay at zero — the
 * caller owns chunking, and one flash call must carry one whole piece.
 */
export function buildTranscribeArguments(req: SeedAsrFlashRequest): Record<string, unknown> {
  return {
    audio_base64: req.audioBase64,
    input_format: req.audioFormat,
    input_path: "",
    language: req.language ?? "",
    timeout_seconds: 0,
    chunk_seconds: 0,
    retries: 0,
    retry_backoff_seconds: 0,
  };
}

/** Official flash result body: `{result:{text, utterances}, audio_info?}` (ms timestamps). */
export interface SeedAsrFlashResponse {
  result: {
    text: string;
    utterances: Array<{
      text: string;
      start_time: number;
      end_time: number;
      words?: Array<{ text: string; start_time: number; end_time: number }>;
      additions?: { speaker: string };
    }>;
  };
  audio_info?: { duration: number };
}

const secondsToMs = (value: unknown): number => {
  const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return Math.round(n * 1000);
};

/** Map the video_edit structured response onto the official flash shape. Pure — direct-tested. */
export function mapTranscriptToFlash(data: Record<string, unknown>): { response?: SeedAsrFlashResponse; silent?: boolean } {
  if (data.silent_audio === true) return { silent: true };
  const transcript = data.transcript && typeof data.transcript === "object" && !Array.isArray(data.transcript)
    ? (data.transcript as Record<string, unknown>)
    : {};
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const utterances: SeedAsrFlashResponse["result"]["utterances"] = [];
  for (const seg of segments) {
    if (typeof seg !== "object" || seg === null) continue;
    const s = seg as Record<string, unknown>;
    const text = typeof s.text === "string" ? s.text : "";
    const words = Array.isArray(s.words)
      ? s.words
          .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
          .map((w) => ({
            text: typeof w.text === "string" ? w.text : "",
            start_time: secondsToMs(w.start),
            end_time: secondsToMs(w.end),
          }))
          .filter((w) => w.text)
      : undefined;
    const speaker = typeof s.speaker === "string" && s.speaker.trim() ? s.speaker.trim() : undefined;
    if (!text && (!words || words.length === 0)) continue;
    utterances.push({
      text,
      start_time: secondsToMs(s.start),
      end_time: secondsToMs(s.end),
      ...(words && words.length ? { words } : {}),
      ...(speaker ? { additions: { speaker } } : {}),
    });
  }
  let text = typeof transcript.text === "string" ? transcript.text.trim() : "";
  if (!text) text = utterances.map((u) => u.text).filter(Boolean).join("\n");
  const out: SeedAsrFlashResponse = { result: { text, utterances } };
  const durationSeconds = transcript.audio_duration_seconds;
  if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
    out.audio_info = { duration: secondsToMs(durationSeconds) };
  }
  return { response: out };
}

/**
 * One blocking flash call. Long audio legitimately runs minutes upstream —
 * timeout 3600s matches the plugin's ASR budget ceiling (media.py
 * ASR_TIMEOUT_SECONDS).
 */
export async function flashTranscribe(client: VideoEditClient, req: SeedAsrFlashRequest): Promise<{ response?: SeedAsrFlashResponse; silent?: boolean }> {
  const { data } = await client.callTool("speech_transcribe", buildTranscribeArguments(req), 3_600_000);
  const mapped = mapTranscriptToFlash(data);
  if (!mapped.silent && !mapped.response) {
    throw new MediaUpstreamError("speech_transcribe returned an unrecognized transcript shape", "upstream");
  }
  return mapped;
}
