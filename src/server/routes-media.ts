/**
 * Seed-family media routes — the THIN layer (zero business logic per
 * src/server/AGENTS.md): auth gate → body cap → parse → call the src/media
 * service → shape the Ark error surface on failure.
 *
 * All four faces are coding-plan entitlements served through ToolHub and the
 * official video_edit MCP with the same identity headers as /mcp; start-plan
 * / API-key-only connections are rejected here with an explicit 400
 * (`plan_unsupported` / `credentials_unavailable`), mirroring routes-mcp and
 * routes-async — the gateway's own 3101 verdict, surfaced before the
 * round-trip.
 *
 * Error shape is the Volcano Ark dialect `{"error":{"code":"<string>",
 * "message"}}` — NOT proxy/handler.ts errorResponse's `{error:{type}}`:
 * these routes are consumed by clients written against the official Volcano
 * docs.
 *
 * Route registration lives in `server.ts` (gated by `config.media.enabled`).
 *
 * @see src/media/shared.ts（门禁/错误分类/体限）
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { randomUUID } from "node:crypto";
import {
  arkErrorFor,
  arkErrorResponse,
  MediaBodyTooLargeError,
  MediaUpstreamError,
  readJsonBodyWithCap,
  resolveMediaAuthFrom,
} from "../media/shared.js";
import { generateImage, parseSeedImageRequest } from "../media/seed-image.js";
import { createVideoTask, getVideoTask, parseSeedVideoCreateRequest } from "../media/seed-video.js";
import { flashTranscribe, parseAsrFlashRequest } from "../media/seed-asr.js";
import { parseTtsCreateRequest, synthesizeSpeech } from "../media/seed-tts.js";
import type { ToolHubDeps } from "../media/toolhub.js";
import { VideoEditClient, type VideoEditDeps } from "../media/video-edit.js";

export interface MediaRouteOptions {
  config: ProxyConfig;
  auth: AuthManager;
  fetchImpl?: typeof fetch;
  /** Same-key retry backoff for ToolHub calls (production 5s; tests inject ~1ms). */
  retryDelayMs?: number;
}

/** Request-body caps per face. ASR 45 MiB = the upstream entry-nginx cap
 *  (video_edit speech plane); video 4 MiB = ToolHub request cap; images
 *  14 MiB = one ≤10 MiB base64 reference (4/3 inflation ≈13.3 MiB) plus
 *  envelope — a 12 MiB cap would 413 a spec-legal 10 MiB inline reference
 *  before MAX_REFERENCE_BYTES ever binds. */
const BODY_CAPS = {
  images: 14 * 1024 * 1024,
  video: 4 * 1024 * 1024,
  asr: 45 * 1024 * 1024,
  tts: 1024 * 1024,
} as const;

type AuthedResult = { ok: true; origin: string; headers: Record<string, string> } | { response: Response };

async function resolveAuth(opts: MediaRouteOptions): Promise<AuthedResult> {
  const status = await resolveMediaAuthFrom(opts.auth, opts.config.plan);
  if (!status.ok) {
    const code = status.reason === "plan_unsupported" ? "plan_unsupported" : "credentials_unavailable";
    return { response: arkErrorResponse(400, code, status.message) };
  }
  return { ok: true, origin: opts.config.media.upstreamOrigin, headers: status.auth.headers };
}

function depsFor(opts: MediaRouteOptions, authed: { origin: string; headers: Record<string, string> }): {
  toolhub: ToolHubDeps;
  videoEdit: VideoEditDeps;
  fetchImpl: typeof fetch;
} {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    toolhub: {
      origin: authed.origin,
      headers: authed.headers,
      fetchImpl,
      ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
    },
    videoEdit: { origin: authed.origin, headers: authed.headers, fetchImpl },
    fetchImpl,
  };
}

async function asArkError(err: unknown): Promise<Response> {
  if (err instanceof MediaUpstreamError) return arkErrorFor(err);
  if (err instanceof MediaBodyTooLargeError) return arkErrorResponse(413, "request_too_large", err.message);
  return arkErrorResponse(502, "upstream_error", `media request failed: ${(err as Error).message}`);
}

function isBodyTooLargeMessage(err: unknown): err is MediaBodyTooLargeError {
  return err instanceof MediaBodyTooLargeError;
}

/** POST /api/v3/images/generations — Seedream face. */
export async function handleImagesGenerations(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.images);
    const parsed = parseSeedImageRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const d = depsFor(opts, authed);
    const result = await generateImage(d.toolhub, d.fetchImpl, parsed.req);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return asArkError(err);
  }
}

/** POST /api/v3/contents/generations/tasks — SeedDance create-task face. */
export async function handleVideoTaskCreate(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.video);
    const parsed = parseSeedVideoCreateRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const result = await createVideoTask(depsFor(opts, authed).toolhub, parsed.req);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return asArkError(err);
  }
}

/** GET /api/v3/contents/generations/tasks/{id} — SeedDance query face. */
export async function handleVideoTaskQuery(opts: MediaRouteOptions, taskId: string): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  try {
    const result = await getVideoTask(depsFor(opts, authed).toolhub, taskId);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return asArkError(err);
  }
}

/**
 * DELETE /api/v3/contents/generations/tasks/{id} — the official API supports
 * cancel/delete; ToolHub has no task-cancel surface, so this face is
 * explicitly unsupported (501, not a silent no-op that would let a caller
 * believe a charged task was cancelled). Still passes the plan/credential
 * gate first so a start-plan caller gets the standard 400, consistent with
 * the GET face on the same prefix.
 */
export async function handleVideoTaskDelete(opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  return arkErrorResponse(
    501,
    "not_supported",
    "task cancel/delete is not supported by this proxy's upstream — tasks run to completion; query the task instead",
  );
}

/** POST /api/v3/auc/bigmodel/recognize/flash — Seed-ASR sync face. */
export async function handleAsrFlash(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  // 官方姿势是 X-Api-Request-Id 自带；缺失时本地生成一个（响应头回显）。
  const requestId = req.headers.get("x-api-request-id")?.trim() || randomUUID();
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.asr);
    const parsed = parseAsrFlashRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const client = new VideoEditClient(depsFor(opts, authed).videoEdit);
    const result = await flashTranscribe(client, parsed.req);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-request-id": requestId,
      // Status header, the plugin's cloud_asr reads: ok / silent-audio.
      "x-api-status-code": result.silent ? "20000003" : "20000000",
    };
    const payload = result.silent ? {} : result.response;
    return new Response(JSON.stringify(payload), { status: 200, headers });
  } catch (err) {
    if (isBodyTooLargeMessage(err)) {
      return arkErrorResponse(
        413,
        "request_too_large",
        `request body exceeds the 45 MiB upstream cap — split the audio client-side and send one flash request per chunk`,
        { "x-api-request-id": requestId },
      );
    }
    return asArkError(err);
  }
}

/**
 * POST /api/v3/auc/bigmodel/{submit,query} — the official async ASR pair.
 * Deliberately NOT emulated: the upstream speech plane is a single blocking
 * call (the plugin sends one speech_transcribe per chunk, zero server-side
 * tasking), so an async face would be a fake task table over synchronous
 * work. 501 with the sync alternative spelled out.
 */
export function handleAsrSubmitQueryUnsupported(): Response {
  return arkErrorResponse(
    501,
    "not_supported",
    "async submit/query is not supported by this proxy — the speech plane is synchronous; use POST /api/v3/auc/bigmodel/recognize/flash (chunk oversized audio client-side, 45 MiB per request)",
  );
}

/** POST /api/v3/tts/create — Seed-Audio face. */
export async function handleTtsCreate(req: Request, opts: MediaRouteOptions): Promise<Response> {
  const authed = await resolveAuth(opts);
  if ("response" in authed) return authed.response;
  const requestId = req.headers.get("x-api-request-id")?.trim() || randomUUID();
  try {
    const body = await readJsonBodyWithCap(req, BODY_CAPS.tts);
    const parsed = parseTtsCreateRequest(body);
    if (!parsed.ok) throw new MediaUpstreamError(parsed.message, parsed.kind);
    const client = new VideoEditClient(depsFor(opts, authed).videoEdit);
    const result = await synthesizeSpeech(client, parsed.req);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", "x-api-request-id": requestId },
    });
  } catch (err) {
    return asArkError(err);
  }
}
