/**
 * SeedDance-compatible video generation face (`POST|GET
 * /api/v3/contents/generations/tasks`) → ToolHub `video_generate`
 * invoke/tasks-query translation.
 *
 * Official content[] roles map 1:1 onto the ToolHub material params
 * (video-generation/0.2.0/mcp/server.mjs `buildSubmitBody`):
 *   reference_image→images[] (≤9, https/data: passthrough)
 *   reference_video→videos[] (≤3, https/asset:// ONLY — ToolHub rejects
 *                    local data: videos)
 *   reference_audio→audios[] (≤3, https or data: ≤2 MiB inline — the 4 MiB
 *                    request body cap bounds base64 audio)
 *   first_frame/last_frame → the exclusive first/last-frame pair.
 *
 * Deliberate deviations (declared, pinned in the parser):
 *   - Ark fields with no ToolHub counterpart (resolution, camera_fixed,
 *     watermark, seed, generate_audio, return_last_frame,
 *     execution_expires_after, tools) are accepted and IGNORED;
 *   - Ark's default ratio is "adaptive" while ToolHub defaults to "16:9" —
 *     an omitted ratio is sent as "adaptive" to mirror the official default,
 *     except when a first_frame is present (ToolHub requires ratio absent
 *     or "adaptive" then; absent is mirrored as absent);
 *   - multiple text content items are joined with "\n" into one `query`.
 *
 * @see src/media/toolhub.ts（submitVideo / queryVideo 语义来源）
 */
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";
import { queryVideo, submitVideo, type ToolHubDeps } from "./toolhub.js";

export interface SeedVideoCreateRequest {
  model?: string;
  prompt: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
  firstFrame?: string;
  lastFrame?: string;
  duration?: number;
  ratio?: string;
}

export const VIDEO_RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);
const MAX_AUDIOS = 3;
const MAX_IMAGES = 9;
const MAX_VIDEOS = 3;
const MAX_INLINE_AUDIO_BYTES = 2 * 1024 * 1024;

/** Parse + validate the Ark-shaped create-task body. Pure — direct-tested. */
export function parseSeedVideoCreateRequest(body: unknown): { ok: true; req: SeedVideoCreateRequest } | { ok: false; kind: MediaUpstreamKind; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, kind: "param", message: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.content) || raw.content.length === 0) {
    return { ok: false, kind: "param", message: "content is required and must be a non-empty array" };
  }

  const texts: string[] = [];
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  let firstFrame: string | undefined;
  let lastFrame: string | undefined;

  for (const [index, item] of raw.content.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, kind: "param", message: `content[${index}] must be an object` };
    }
    const entry = item as Record<string, unknown>;
    const type = entry.type;
    const url = contentItemUrl(entry);
    if (type === "text") {
      if (typeof entry.text === "string" && entry.text.trim()) texts.push(entry.text);
      continue;
    }
    if (type === "image_url" || type === "video_url" || type === "audio_url") {
      if (typeof url !== "string" || !url.trim()) {
        return { ok: false, kind: "param", message: `content[${index}] (${type}) requires a url` };
      }
      // Official default role per type (omitted role = plain reference material).
      const defaultRole = type === "image_url" ? "reference_image" : type === "video_url" ? "reference_video" : "reference_audio";
      const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim() : defaultRole;
      if (type === "image_url") {
        if (role === "first_frame") {
          if (firstFrame) return { ok: false, kind: "param", message: "content contains more than one first_frame image" };
          firstFrame = url.trim();
        } else if (role === "last_frame") {
          if (lastFrame) return { ok: false, kind: "param", message: "content contains more than one last_frame image" };
          lastFrame = url.trim();
        } else if (role === "reference_image") {
          if (images.length >= MAX_IMAGES) return { ok: false, kind: "param", message: `at most ${MAX_IMAGES} reference images` };
          images.push(url.trim());
        } else {
          return { ok: false, kind: "param", message: `content[${index}]: role "${role}" is not valid for image_url (first_frame | last_frame | reference_image)` };
        }
        continue;
      }
      if (type === "video_url") {
        if (role !== "reference_video") {
          return { ok: false, kind: "param", message: `content[${index}]: role "${role}" is not valid for video_url (reference_video)` };
        }
        if (videos.length >= MAX_VIDEOS) return { ok: false, kind: "param", message: `at most ${MAX_VIDEOS} reference videos` };
        videos.push(url.trim());
        continue;
      }
      // audio_url
      if (role !== "reference_audio") {
        return { ok: false, kind: "param", message: `content[${index}]: role "${role}" is not valid for audio_url (reference_audio)` };
      }
      if (audios.length >= MAX_AUDIOS) return { ok: false, kind: "param", message: `at most ${MAX_AUDIOS} reference audios` };
      audios.push(url.trim());
      continue;
    }
    return { ok: false, kind: "param", message: `content[${index}].type must be text | image_url | video_url | audio_url` };
  }

  const prompt = texts.join("\n").trim();
  if (!prompt && images.length + videos.length + audios.length === 0 && !firstFrame && !lastFrame) {
    return { ok: false, kind: "param", message: "content must carry at least a text prompt or one reference material" };
  }

  // ToolHub rule (plugin buildSubmitBody): 首尾帧与参考素材互斥。
  if ((firstFrame || lastFrame) && images.length + videos.length + audios.length > 0) {
    return { ok: false, kind: "param", message: "first/last-frame images are mutually exclusive with reference images/videos/audios" };
  }
  if (lastFrame && !firstFrame) {
    return { ok: false, kind: "param", message: "last_frame requires a first_frame item" };
  }

  let duration: number | undefined;
  if (raw.duration !== undefined && raw.duration !== null) {
    const n = typeof raw.duration === "string" && raw.duration.trim() !== "" ? Number(raw.duration) : raw.duration;
    if (typeof n !== "number" || !Number.isInteger(n) || (n !== -1 && (n < 4 || n > 30))) {
      return { ok: false, kind: "param", message: "duration must be an integer 4..30, or -1 (model decides)" };
    }
    duration = n;
  }

  let ratio: string | undefined;
  if (typeof raw.ratio === "string" && raw.ratio.trim()) {
    const candidate = raw.ratio.trim().toLowerCase();
    if (!VIDEO_RATIOS.has(candidate)) {
      return { ok: false, kind: "param", message: `ratio must be one of ${[...VIDEO_RATIOS].join(" / ")}` };
    }
    if (firstFrame && candidate !== "adaptive") {
      return { ok: false, kind: "param", message: 'with a first_frame the ratio follows the frame image: omit ratio or pass "adaptive"' };
    }
    ratio = candidate;
  } else if (!firstFrame) {
    // Ark default is adaptive; ToolHub's own default is 16:9 — send the
    // official default explicitly (first_frame requests must omit it).
    ratio = "adaptive";
  }

  return {
    ok: true,
    req: {
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      prompt,
      ...(images.length ? { images } : {}),
      ...(videos.length ? { videos } : {}),
      ...(audios.length ? { audios } : {}),
      ...(firstFrame ? { firstFrame } : {}),
      ...(lastFrame ? { lastFrame } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(ratio ? { ratio } : {}),
    },
  };
}

/** `image_url: {url}` object form; lenient fallback: bare `url` string. */
function contentItemUrl(entry: Record<string, unknown>): unknown {
  const typed = entry.image_url ?? entry.video_url ?? entry.audio_url;
  if (typed && typeof typed === "object" && !Array.isArray(typed)) {
    return (typed as Record<string, unknown>).url;
  }
  return entry.url;
}

/** Build the ToolHub submit body (mirrors buildSubmitBody field-for-field). */
export function buildToolhubVideoBody(req: SeedVideoCreateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { query: req.prompt };
  if (req.duration !== undefined) body.duration = req.duration;
  if (req.ratio !== undefined) body.ratio = req.ratio;
  if (req.firstFrame) {
    body.first_frame = req.firstFrame;
    if (req.lastFrame) body.last_frame = req.lastFrame;
    return body;
  }
  if (req.images?.length) body.images = req.images;
  if (req.videos?.length) body.videos = req.videos;
  if (req.audios?.length) body.audios = req.audios;
  return body;
}

/** ToolHub videos only accept https/asset:// (audio/image data: URLs pass through). */
export function validateVideoMaterialUrls(req: SeedVideoCreateRequest): { ok: true } | { ok: false; message: string } {
  for (const video of req.videos ?? []) {
    if (!/^(https|asset):\/\//i.test(video)) {
      return { ok: false, message: "reference videos only accept https:// or asset:// URLs (data:/http: and local paths are rejected upstream)" };
    }
  }
  for (const audio of req.audios ?? []) {
    if (/^data:/i.test(audio)) {
      // base64 ≈ 4/3 inflation — bound the decoded size before the request
      // body cap turns it into an opaque 413.
      const comma = audio.indexOf(",", 5);
      const encoded = comma >= 0 ? audio.slice(comma + 1).replace(/[ \t\r\n\f]+/g, "") : "";
      if (Math.floor((encoded.length * 3) / 4) > MAX_INLINE_AUDIO_BYTES) {
        return { ok: false, message: "inline data: reference audio exceeds 2 MiB — provide an https URL instead" };
      }
    } else if (!/^(https|asset):\/\//i.test(audio)) {
      return { ok: false, message: "reference audios only accept https://, asset:// or data:audio/... URLs" };
    }
  }
  return { ok: true };
}

export interface SeedVideoCreateResponse {
  id: string;
  model: string;
  status: "queued";
}

export async function createVideoTask(deps: ToolHubDeps, req: SeedVideoCreateRequest): Promise<SeedVideoCreateResponse> {
  const materialCheck = validateVideoMaterialUrls(req);
  if (!materialCheck.ok) throw new MediaUpstreamError(materialCheck.message, "param");
  const { taskId } = await submitVideo(deps, buildToolhubVideoBody(req));
  return { id: taskId, model: req.model ?? "doubao-seedance", status: "queued" };
}

export interface SeedVideoTaskResponse {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
  content?: { video_url: string };
  usage?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** Map a ToolHub task snapshot onto the Ark query shape. Pure — direct-tested. */
export function mapVideoTaskSnapshot(id: string, snapshot: {
  status: string;
  videoUrl?: string;
  failure?: { code?: string; message?: string };
  usage?: Record<string, unknown>;
}): SeedVideoTaskResponse {
  const out: SeedVideoTaskResponse = { id, status: "running" };
  if (snapshot.status === "succeeded" && snapshot.videoUrl) {
    out.status = "succeeded";
    out.content = { video_url: snapshot.videoUrl };
  } else if (snapshot.status === "failed") {
    out.status = "failed";
    out.error = {
      code: snapshot.failure?.code ?? "upstream_failure",
      message: snapshot.failure?.message ?? "video generation failed upstream",
    };
  }
  // Everything else (queued/processing/unknown upstream statuses) → "running":
  // ToolHub's non-terminal vocabulary is not enumerated anywhere in the
  // plugin source, and "running" keeps official pollers looping.
  if (snapshot.usage) out.usage = snapshot.usage;
  return out;
}

export async function getVideoTask(deps: ToolHubDeps, taskId: string): Promise<SeedVideoTaskResponse> {
  const snapshot = await queryVideo(deps, taskId);
  return mapVideoTaskSnapshot(taskId, snapshot);
}
