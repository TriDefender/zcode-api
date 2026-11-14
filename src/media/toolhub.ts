/**
 * ToolHub REST client — ZCode server-hosted tool plane
 * (`{origin}/api/v1/toolhub/...`), the same upstream the official
 * image-generation / video-generation stdio plugins call with the host-
 * injected identity headers (here: `buildOfficialMcpAuthHeaders` output).
 *
 * Semantics are mirrored from the plugin sources (read 2026-11-14):
 *   - image-generation/0.1.1/mcp/server.mjs  → invokeImage / uploadFile
 *     (`apiRequest` + `invokeGenerate` + `uploadBytes`): transient failures
 *     (HTTP 429/5xx, codes 2005/2007/3002/3702) retry ONCE with the SAME
 *     `Idempotency-Key`; state CALLING is polled (same key) up to 2 more
 *     times; every POST carries `redirect: "manual"` so the identity headers
 *     can never leak across origins.
 *   - video-generation/0.2.0/mcp/server.mjs → submitVideo / queryVideo
 *     (`submitTask` / `waitForTask`): submit retries share one Idempotency-Key
 *     (successful replays answer `replayed=true` + `upstream_req_id`, so no
 *     double charge); result-uncertain exhaustion throws without a task id.
 *
 * Deliberate deviation vs video-generation plugin: the plugin persists the
 * first-submit request body to the plugin data dir so a later
 * `generate_video(request_id=…)` can replay it byte-exact. This plane has no
 * per-client workspace to persist into; an unconfirmed submit surfaces as a
 * 502 and the caller re-submits (risking one duplicate charge) — declared in
 * seed-video.ts.
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"（头契约）
 */
import { randomUUID } from "node:crypto";
import { MediaUpstreamError } from "./shared.js";

export interface ToolHubDeps {
  origin: string;
  /** Official identity headers (Authorization + X-Bigmodel-Authorization + …). */
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  /** Retry backoff between same-key attempts (production 5s; tests inject ~1ms). */
  retryDelayMs?: number;
}

/** ToolHub envelope code → number (safe integers + canonical decimal strings only). */
function envelopeCode(value: unknown): number | undefined {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

const TRANSIENT_CODES = new Set([2005, 2007, 3002, 3702]);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type ToolHubResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; transient: true; unconfirmed?: boolean; code?: number; message: string };

/**
 * One ToolHub POST. Terminal failures throw MediaUpstreamError; transient
 * failures come back for the caller's same-key retry ladder.
 */
async function toolhubPost(
  deps: ToolHubDeps,
  path: string,
  init: { headers?: Record<string, string>; body: BodyInit; timeoutMs: number },
): Promise<ToolHubResult> {
  let resp: Response;
  try {
    resp = await deps.fetchImpl(deps.origin + path, {
      method: "POST",
      headers: { ...deps.headers, ...(init.headers ?? {}) },
      body: init.body,
      // 身份头只能发往 ZCode 自己的 origin，禁止跟随重定向（镜像插件）。
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    // 请求可能已到服务端：结果未确认，同键重试不重复扣费。
    return { ok: false, transient: true, unconfirmed: true, message: timedOut ? "upstream request timed out" : `network error: ${(err as Error).message}` };
  }
  if (resp.status >= 300 && resp.status < 400) {
    throw new MediaUpstreamError("upstream returned a redirect — rejected (identity headers must not cross origins)", "upstream");
  }
  if (resp.status === 401) throw new MediaUpstreamError("upstream rejected the credential (HTTP 401) — re-run `auth login`", "auth");
  if (resp.status === 403) throw new MediaUpstreamError("upstream denied access (HTTP 403) — the account lacks this entitlement", "forbidden");
  if (resp.status === 429) return { ok: false, transient: true, code: 3002, message: "rate limited (HTTP 429)" };

  let text: string;
  try {
    text = await resp.text();
  } catch (err) {
    return { ok: false, transient: true, unconfirmed: true, message: `failed reading the response body: ${(err as Error).message}` };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    if (resp.status >= 500) return { ok: false, transient: true, unconfirmed: true, message: `upstream error HTTP ${resp.status} (non-JSON body)` };
    throw new MediaUpstreamError(`upstream returned an unrecognizable response (HTTP ${resp.status})`, "upstream");
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    if (resp.status >= 500) return { ok: false, transient: true, unconfirmed: true, message: `upstream error HTTP ${resp.status}` };
    throw new MediaUpstreamError(`upstream returned an unrecognizable response (HTTP ${resp.status})`, "upstream");
  }
  const env = envelope as { code?: unknown; data?: unknown; msg?: unknown; message?: unknown };
  const code = envelopeCode(env.code);
  const msg = typeof env.msg === "string" ? env.msg : typeof env.message === "string" ? env.message : "";
  if (code === 0 && resp.ok) {
    const data = env.data && typeof env.data === "object" && !Array.isArray(env.data) ? (env.data as Record<string, unknown>) : {};
    return { ok: true, data };
  }
  const detail = msg ? `: ${msg}` : "";
  const coded = code !== undefined ? ` (toolhub code ${code})` : "";
  if (code !== undefined && TRANSIENT_CODES.has(code)) {
    return { ok: false, transient: true, code, unconfirmed: code === 3702, message: `transient upstream failure${detail}${coded}` };
  }
  if (resp.status >= 500) return { ok: false, transient: true, unconfirmed: true, message: `upstream error HTTP ${resp.status}${detail}${coded}` };

  // Terminal non-transient codes → typed MediaUpstreamError (mapping table in
  // shared.arkErrorFor): 3001/3707 params, 3704 not-found, 3701/3705
  // unavailable, 3706 forbidden (needs Z.ai account + phone binding).
  const kind = code === 3001 || code === 3707 ? "param"
    : code === 3704 ? "not_found"
    : code === 3706 ? "forbidden"
    : code === 3701 || code === 3705 ? "unavailable"
    : "upstream";
  throw new MediaUpstreamError(`upstream rejected the request${detail}${coded}`, kind);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// ── files upload ────────────────────────────────────────────────────────────

/**
 * Upload one file to ToolHub, get a presigned https URL. Multipart body,
 * one transient retry (the upload endpoint has no idempotency key; a retry
 * may leave an orphan temp object upstream — mirrors the plugin's cap of one).
 */
export async function uploadFile(deps: ToolHubDeps, bytes: Uint8Array, mime: string, name: string): Promise<string> {
  let result: ToolHubResult | undefined;
  let attempt = 1;
  for (;;) {
    const form = new FormData();
    form.append("file", new Blob([bytes as BlobPart], { type: mime }), name);
    result = await toolhubPost(deps, "/api/v1/toolhub/files", { body: form, timeoutMs: 60_000 });
    if (result.ok) break;
    if (attempt >= 2) {
      throw new MediaUpstreamError(`reference upload failed: ${result.message}`, result.code === 3002 ? "rate_limit" : "upstream");
    }
    attempt += 1;
    await sleep(deps.retryDelayMs ?? 5_000);
  }
  const url = str(result.data.url);
  if (!url) throw new MediaUpstreamError("reference upload returned no URL", "upstream");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaUpstreamError("reference upload returned an unparseable URL", "upstream");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new MediaUpstreamError("reference upload returned a non-https URL — the generation service only accepts https references", "param");
  }
  return parsed.href;
}

// ── image_generate ──────────────────────────────────────────────────────────

export interface ImageInvokeResult {
  imageUrl: string;
  invocationId?: string;
}

/**
 * Synchronous image generation (the upstream takes ≥130s per the plugin
 * contract; per-request timeout 150s). Transient failures retry once and
 * CALLING is re-asked — all with the SAME Idempotency-Key so a completed
 * generation is never charged twice.
 */
export async function invokeImage(deps: ToolHubDeps, body: { query: string; image?: string }): Promise<ImageInvokeResult> {
  const headers = { "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  let transientRetried = false;
  for (let attempt = 1; ; attempt += 1) {
    const result = await toolhubPost(deps, "/api/v1/toolhub/tool/image_generate/invoke", {
      headers,
      body: JSON.stringify(body),
      timeoutMs: 150_000,
    });
    if (!result.ok) {
      if (transientRetried) {
        // HTTP 429 / envelope 3002 are definitive rejections (nothing was
        // accepted) — surface them as 429 so Volcano-doc clients can engage
        // their backoff; other transients (network/timeout/5xx/3702) may
        // already have been accepted → 502 with the double-billing hint.
        throw new MediaUpstreamError(
          `image generation failed: ${result.message}${result.unconfirmed ? " — the request may already have been accepted; retry only after a pause to avoid double billing" : ""}`,
          result.code === 3002 ? "rate_limit" : "upstream",
        );
      }
      transientRetried = true;
      await sleep(deps.retryDelayMs ?? 5_000);
      continue;
    }
    const data = result.data as { state?: unknown; output?: unknown; replayed?: unknown; invocation_id?: unknown };
    const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : {};
    if (data.state === "SUCCEEDED") {
      const imageUrl = str(output.image_url);
      if (imageUrl) return { imageUrl, invocationId: str(data.invocation_id) };
      if (data.replayed === true) {
        throw new MediaUpstreamError("this generation's result has already been returned and cannot be fetched again — submit a new generation", "upstream");
      }
      throw new MediaUpstreamError("image generation succeeded but returned no image URL", "upstream");
    }
    if (data.state === "UNKNOWN") {
      throw new MediaUpstreamError("image generation result unconfirmed (upstream timeout) — retry after a pause to avoid double billing", "upstream");
    }
    if (data.state === "CALLING" && attempt < 3) {
      await sleep(deps.retryDelayMs ?? 5_000);
      continue;
    }
    throw new MediaUpstreamError(`image generation did not complete (state=${typeof data.state === "string" ? data.state : "unknown"})`, "upstream");
  }
}

// ── video_generate ──────────────────────────────────────────────────────────

export interface VideoSubmitResult {
  taskId: string;
  invocationId?: string;
}

/**
 * Submit a video task (submit + poll upstream; the submit returns the task id
 * quickly). Up to 4 attempts sharing one Idempotency-Key: transient failures,
 * UNKNOWN and CALLING all re-POST the same body — a successful replay answers
 * `replayed=true` + `upstream_req_id` so nothing is double-charged.
 */
export async function submitVideo(deps: ToolHubDeps, body: Record<string, unknown>): Promise<VideoSubmitResult> {
  const headers = { "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  // `uncertain` mirrors the plugin's flag: ONLY result-unconfirmed transients
  // (network/timeout/unparseable 5xx/3702) and UNKNOWN/CALLING states mean the
  // task may already exist upstream. HTTP 429 / envelope 3002 are definitive
  // rejections — nothing was accepted, so resubmission is safe and the error
  // must surface as a plain 429, not a double-billing warning.
  let uncertain = false;
  let rateLimited = false;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt > 1) await sleep(deps.retryDelayMs ?? 5_000);
    let result: ToolHubResult;
    try {
      result = await toolhubPost(deps, "/api/v1/toolhub/tool/video_generate/invoke", {
        headers,
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      });
    } catch (err) {
      throw err instanceof MediaUpstreamError
        ? new MediaUpstreamError(`video submit failed: ${err.message}`, err.kind)
        : err;
    }
    if (!result.ok) {
      uncertain = uncertain || result.unconfirmed === true;
      rateLimited = rateLimited || result.code === 3002;
      continue;
    }
    const data = result.data as { state?: unknown; output?: unknown; upstream_req_id?: unknown; invocation_id?: unknown };
    const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : {};
    const taskId = str(output.task_id) ?? str(data.upstream_req_id);
    if (data.state === "SUCCEEDED" && taskId) {
      return { taskId, invocationId: str(data.invocation_id) };
    }
    if (data.state === "UNKNOWN" || data.state === "CALLING") {
      uncertain = true;
      continue;
    }
  }
  if (rateLimited && !uncertain) {
    throw new MediaUpstreamError(
      "video submit was rate limited upstream after retries — no task was created; wait and retry later",
      "rate_limit",
    );
  }
  throw new MediaUpstreamError(
    "video submit could not be confirmed after retries — a task may already have been created and charged; wait before re-submitting",
    "upstream",
  );
}

export interface VideoTaskSnapshot {
  status: string;
  videoUrl?: string;
  failure?: { code?: string; message?: string };
  usage?: Record<string, unknown>;
  /** Raw upstream status for mapping (unknown statuses → "running" upstream-facing). */
  rawStatus: string;
}

/**
 * Query one video task. code 3704 (不存在/已过期/非本人任务) is terminal —
 * surfaced as kind "not_found"; other error codes throw as upstream failures.
 */
export async function queryVideo(deps: ToolHubDeps, taskId: string): Promise<VideoTaskSnapshot> {
  const result = await toolhubPost(deps, "/api/v1/toolhub/tool/video_generate/tasks/query", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    // Terminal codes (3704 not-found, 3706 forbidden, …) already throw with
    // their kind inside toolhubPost; a transient here can only be a genuine
    // in-flight hiccup (2005/2007/3702/network) or a rate limit (HTTP 429 /
    // envelope 3002) — the latter surfaces as 429, not 502.
    throw new MediaUpstreamError(`video task query failed: ${result.message}`, result.code === 3002 ? "rate_limit" : "upstream");
  }
  const data = result.data as { status?: unknown; output?: unknown; failure?: unknown; usage?: unknown };
  const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : {};
  const status = typeof data.status === "string" ? data.status : "unknown";
  const snapshot: VideoTaskSnapshot = { status, rawStatus: status };
  if (status === "succeeded") {
    snapshot.videoUrl = str(output.video_url);
    if (!snapshot.videoUrl) {
      throw new MediaUpstreamError("video task succeeded but returned no video URL", "upstream");
    }
  } else if (status === "failed") {
    const failure = data.failure && typeof data.failure === "object" ? (data.failure as Record<string, unknown>) : {};
    snapshot.failure = {
      ...(failure.code !== undefined ? { code: String(failure.code) } : {}),
      ...(typeof failure.message === "string" ? { message: failure.message } : {}),
    };
  }
  if (data.usage && typeof data.usage === "object" && !Array.isArray(data.usage)) {
    snapshot.usage = data.usage as Record<string, unknown>;
  }
  return snapshot;
}
