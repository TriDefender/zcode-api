/**
 * ToolHub task faces for the requiresPaidPlan marketplace family
 * (2026-11-20): HappyHorse video (阿里, via `happyhorse_video`) and the three
 * 3D generators (`hyper3d_model3d` = Deemos Rodin, `meshy_model3d` = Meshy AI,
 * `hi3d_model3d` = 数美万物) — REST faces over the same
 * invoke/tasks-query plane the official stdio plugins call with host-injected
 * `_meta["com.zcode/official-mcp-auth"]` headers.
 *
 * Semantics mirrored from the plugin sources (read 2026-11-20,
 * `_reverse/plugins-3.19.1/`):
 *   - happyhorse-video/0.1.1/mcp/server.mjs — buildSubmitBody: prompt
 *     (≤10 000), duration 3–15, resolution/ratio enums, first_frame ×
 *     reference_images (≤9) mutually exclusive; material resolution
 *     (`resolveImage`) is https-ONLY — data: is REJECTED (deliberate plugin
 *     behavior, mirrored; http:/ftp:/file: and credentialed URLs rejected).
 *   - hyper3d-3d/0.1.0, meshy-3d/0.1.0, hi3d-3d/0.1.0 — `prepareImage`:
 *     https passthrough OR data:image/...;base64 (strict charset/padding
 *     checks, per-vendor decoded cap 10/20/10 MiB) uploaded to
 *     `/api/v1/toolhub/files` for a presigned https URL.
 *
 * Deliberate deviations (declared, pinned in the parsers):
 *   - the plugins keep a per-action field whitelist (hyper3d/meshy
 *     ACTION_FIELDS) and reject unknown fields locally; this REST face
 *     forwards non-material fields verbatim and lets ToolHub's 3001 be the
 *     authority — the plugins' local validation is a stdio-plugin UX nicety,
 *     not a wire contract;
 *   - unconfirmed submits are not persisted for request_id replay (same
 *     deviation as seed-video.ts: no per-client workspace). A caller-supplied
 *     `request_id` IS honored as the Idempotency-Key, so a stateless caller
 *     that kept its original body can replay byte-exact — the official
 *     plugin's pending-body mechanism minus the storage.
 *
 * @see src/media/toolhub.ts（submitToolhubTask / queryToolhubTask）
 * @see _reverse/NOTEPAD.md「3.19.1 增补」§B（插件逆向）
 */
import { MediaUpstreamError } from "./shared.js";
import { queryToolhubTask, submitToolhubTask, uploadFile, type ToolHubDeps } from "./toolhub.js";

// ── happyhorse_video ────────────────────────────────────────────────────────

const HAPPYHORSE_TOOL = "happyhorse_video";
/** Billing scenario name (plugin USAGE_SCENARIO) — hyphenated plugin name, NOT the tool name. */
const HAPPYHORSE_USAGE_SCENARIO = "happyhorse-video";
const HAPPYHORSE_MAX_PROMPT = 10_000;
const HAPPYHORSE_MIN_DURATION = 3;
const HAPPYHORSE_MAX_DURATION = 15;
const HAPPYHORSE_RESOLUTIONS = new Set(["480P", "720P", "1080P"]);
const HAPPYHORSE_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"]);
const HAPPYHORSE_MAX_REFERENCES = 9;
const MAX_URL_CHARS = 2048;

export interface HappyhorseSubmitRequest {
  prompt: string;
  duration?: number;
  resolution?: string;
  ratio?: string;
  firstFrame?: string;
  referenceImages?: string[];
  requestId?: string;
}

/** Parse + validate the happyhorse submit body. Pure — direct-tested. */
export function parseHappyhorseSubmit(body: unknown): { ok: true; req: HappyhorseSubmitRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { ok: false, message: "prompt is required and must be a non-empty string" };
  if (prompt.length > HAPPYHORSE_MAX_PROMPT) {
    return { ok: false, message: `prompt exceeds ${HAPPYHORSE_MAX_PROMPT} characters` };
  }
  let duration: number | undefined;
  if (raw.duration !== undefined && raw.duration !== null && raw.duration !== "") {
    const n = typeof raw.duration === "string" && raw.duration.trim() !== "" ? Number(raw.duration) : raw.duration;
    if (typeof n !== "number" || !Number.isInteger(n) || n < HAPPYHORSE_MIN_DURATION || n > HAPPYHORSE_MAX_DURATION) {
      return { ok: false, message: `duration must be an integer ${HAPPYHORSE_MIN_DURATION}..${HAPPYHORSE_MAX_DURATION} seconds` };
    }
    duration = n;
  }
  let resolution: string | undefined;
  if (typeof raw.resolution === "string" && raw.resolution.trim()) {
    const candidate = raw.resolution.trim().toUpperCase();
    if (!HAPPYHORSE_RESOLUTIONS.has(candidate)) {
      return { ok: false, message: `resolution must be one of ${[...HAPPYHORSE_RESOLUTIONS].join(" / ")}` };
    }
    resolution = candidate;
  }
  let ratio: string | undefined;
  if (typeof raw.ratio === "string" && raw.ratio.trim()) {
    const candidate = raw.ratio.trim();
    if (!HAPPYHORSE_RATIOS.has(candidate)) {
      return { ok: false, message: `ratio must be one of ${[...HAPPYHORSE_RATIOS].join(" / ")}` };
    }
    ratio = candidate;
  }
  const firstFrame = materialUrl(raw.first_frame, "first_frame");
  if (firstFrame && firstFrame.error) return { ok: false, message: firstFrame.error };
  const referencesRaw = raw.reference_images;
  let referenceImages: string[] | undefined;
  if (referencesRaw !== undefined && referencesRaw !== null) {
    if (!Array.isArray(referencesRaw)) return { ok: false, message: "reference_images must be an array" };
    if (referencesRaw.length > HAPPYHORSE_MAX_REFERENCES) {
      return { ok: false, message: `reference_images accepts at most ${HAPPYHORSE_MAX_REFERENCES} entries` };
    }
    const items: string[] = [];
    for (const [index, value] of referencesRaw.entries()) {
      const item = materialUrl(value, `reference_images[${index}]`);
      if (item.error) return { ok: false, message: item.error };
      items.push(item.url!);
    }
    referenceImages = items;
  }
  if (firstFrame?.url && referenceImages?.length) {
    return { ok: false, message: "first_frame and reference_images are mutually exclusive — pick one mode" };
  }
  const requestId = typeof raw.request_id === "string" && raw.request_id.trim() ? raw.request_id.trim() : undefined;
  if (requestId !== undefined && !/^[!-~]{1,128}$/.test(requestId)) {
    return { ok: false, message: "request_id must be 1-128 printable ASCII characters" };
  }
  return {
    ok: true,
    req: {
      prompt,
      ...(duration !== undefined ? { duration } : {}),
      ...(resolution ? { resolution } : {}),
      ...(ratio ? { ratio } : {}),
      ...(firstFrame?.url ? { firstFrame: firstFrame.url } : {}),
      ...(referenceImages?.length ? { referenceImages } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
}

/**
 * https-only material check (mirrors the plugin's resolveImage: data: is
 * deliberately REJECTED for happyhorse; credentials and non-https schemes
 * rejected; the ratio cap follows the plugin's MAX_URL_CHARS).
 */
function materialUrl(value: unknown, label: string): { url?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !value.trim()) return { error: `${label} must be a non-empty string` };
  const item = value.trim();
  if (/^data:/i.test(item)) {
    return { error: `${label} does not accept data: URLs — provide an https URL (plugin contract)` };
  }
  if (!/^https:\/\//i.test(item)) {
    return { error: `${label} only accepts https URLs` };
  }
  let url: URL;
  try {
    url = new URL(item);
  } catch {
    return { error: `${label} is not a parseable URL` };
  }
  if (url.username || url.password) return { error: `${label} must not carry credentials` };
  if (item.length > MAX_URL_CHARS) return { error: `${label} exceeds ${MAX_URL_CHARS} characters` };
  return { url: item };
}

/** Build the ToolHub submit body (mirrors buildSubmitBody field-for-field). */
export function buildHappyhorseBody(req: HappyhorseSubmitRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (req.duration !== undefined) body.duration = req.duration;
  if (req.resolution) body.resolution = req.resolution;
  if (req.ratio) body.ratio = req.ratio;
  if (req.firstFrame) body.image_url_list = [req.firstFrame];
  if (req.referenceImages?.length) body.reference_image_url_list = req.referenceImages;
  return body;
}

export interface TaskSubmitResponse {
  task_id: string;
  status: "queued";
}

export async function createHappyhorseVideo(deps: ToolHubDeps, req: HappyhorseSubmitRequest): Promise<TaskSubmitResponse> {
  const scenario = { ...deps, usageScenario: HAPPYHORSE_USAGE_SCENARIO };
  const { taskId } = await submitToolhubTask(scenario, HAPPYHORSE_TOOL, buildHappyhorseBody(req), req.requestId);
  return { task_id: taskId, status: "queued" };
}

export interface HappyhorseTaskResponse {
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  video_url?: string;
  error?: { code: string; message: string };
}

export async function getHappyhorseVideo(deps: ToolHubDeps, taskId: string): Promise<HappyhorseTaskResponse> {
  const snapshot = await queryToolhubTask({ ...deps, usageScenario: HAPPYHORSE_USAGE_SCENARIO }, HAPPYHORSE_TOOL, taskId);
  if (snapshot.status === "succeeded") {
    const videoUrl = typeof snapshot.output.video_url === "string" ? snapshot.output.video_url.trim() : "";
    if (!videoUrl) throw new MediaUpstreamError("happyhorse task succeeded but returned no video URL", "upstream");
    return { task_id: taskId, status: "succeeded", video_url: videoUrl };
  }
  if (snapshot.status === "failed") {
    return {
      task_id: taskId,
      status: "failed",
      error: { code: snapshot.failure?.code ?? "upstream_failure", message: snapshot.failure?.message ?? "video generation failed upstream" },
    };
  }
  // Non-terminal vocabulary is not enumerated in the plugin source → running.
  return { task_id: taskId, status: "running" };
}

// ── model3d family (hyper3d / meshy / hi3d) ─────────────────────────────────

export interface Model3dVendorConfig {
  tool: string;
  /** Billing scenario name (plugin USAGE_SCENARIO — equals the tool name for all three 3D vendors). */
  usageScenario: string;
  actions: Set<string>;
  /** Array-of-images material field (all three vendors). */
  imagesField: "images";
  /** Singular material fields, uploaded when data: (hyper3d texture `image`, meshy refine/retexture `texture_image`, hi3d texture `image`). */
  singularImageFields: string[];
  /** Decoded data: cap per image (plugin MAX_IMAGE_BYTES). */
  maxImageBytes: number;
  maxImages: number;
}

export const MODEL3D_VENDORS: Record<string, Model3dVendorConfig> = {
  hyper3d: {
    tool: "hyper3d_model3d",
    usageScenario: "hyper3d_model3d",
    actions: new Set(["generate", "polygen", "texture", "rig"]),
    imagesField: "images",
    singularImageFields: ["image"],
    maxImageBytes: 10 * 1024 * 1024,
    maxImages: 5,
  },
  meshy: {
    tool: "meshy_model3d",
    usageScenario: "meshy_model3d",
    actions: new Set(["generate", "refine", "retexture", "remesh", "convert", "rig", "animate"]),
    imagesField: "images",
    singularImageFields: ["texture_image"],
    maxImageBytes: 20 * 1024 * 1024,
    maxImages: 4,
  },
  hi3d: {
    tool: "hi3d_model3d",
    usageScenario: "hi3d_model3d",
    actions: new Set(["generate", "texture", "split"]),
    imagesField: "images",
    // hi3d texture action's required material (`hi3d server.mjs` `prepareImage(args.image, "image")`).
    singularImageFields: ["image"],
    maxImageBytes: 10 * 1024 * 1024,
    maxImages: 4,
  },
};

export function isModel3dVendor(vendor: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL3D_VENDORS, vendor);
}

const IMAGE_DATA_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/**
 * Build the ToolHub submit body: action validated against the vendor enum;
 * material fields (images[] + singular image fields) resolve https passthrough
 * / strict-base64 data: upload; every other field is forwarded verbatim (the
 * plugins' per-action whitelist is local validation, the upstream 3001 stays
 * the authority — declared deviation).
 */
export async function prepareModel3dBody(
  deps: ToolHubDeps,
  vendor: Model3dVendorConfig,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = typeof raw.action === "string" ? raw.action.trim().toLowerCase() : "";
  if (!action) throw new MediaUpstreamError(`action is required (one of ${[...vendor.actions].join(" / ")})`, "param");
  if (!vendor.actions.has(action)) {
    throw new MediaUpstreamError(`action must be one of ${[...vendor.actions].join(" / ")} for this vendor`, "param");
  }
  const body: Record<string, unknown> = { action };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "action" || key === "request_id") continue;
    if (key === vendor.imagesField) {
      if (!Array.isArray(value)) throw new MediaUpstreamError(`${key} must be an array of image URLs`, "param");
      if (value.length > vendor.maxImages) throw new MediaUpstreamError(`${key} accepts at most ${vendor.maxImages} entries`, "param");
      const items: string[] = [];
      for (const [index, entry] of value.entries()) {
        items.push(await resolveModel3dImage(deps, vendor, entry, `${key}[${index}]`));
      }
      if (items.length) body[key] = items;
      continue;
    }
    if (vendor.singularImageFields.includes(key)) {
      if (value === undefined || value === null) continue;
      // Same treatment as `images`: a present-but-non-string material is a
      // caller error, not something to silently drop (the task would run
      // without its material and fail with an opaque upstream 3001).
      if (typeof value !== "string" || !value.trim()) {
        throw new MediaUpstreamError(`${key} must be a non-empty string (image URL)`, "param");
      }
      body[key] = await resolveModel3dImage(deps, vendor, value, key);
      continue;
    }
    body[key] = value;
  }
  return body;
}

/** https passthrough or strict-base64 data: upload (mirrors prepareImage/decodeDataUrl). */
async function resolveModel3dImage(deps: ToolHubDeps, vendor: Model3dVendorConfig, value: unknown, label: string): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new MediaUpstreamError(`${label} must be a non-empty string`, "param");
  const item = value.trim();
  if (/^https:\/\//i.test(item)) {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new MediaUpstreamError(`${label} is not a parseable https URL`, "param");
    }
    if (url.username || url.password) throw new MediaUpstreamError(`${label} must not carry credentials`, "param");
    // No length cap: the 3D plugins' httpsHref checks protocol/host/credentials
    // only — MAX_URL_CHARS is a happyhorse-plugin constant and presigned
    // reference URLs routinely exceed 2048 chars.
    return item;
  }
  if (/^data:/i.test(item)) return uploadModel3dDataUrl(deps, vendor, item, label);
  throw new MediaUpstreamError(`${label} only accepts https or data:image/...;base64 URLs (http, ftp, file: and bare paths are rejected)`, "param");
}

async function uploadModel3dDataUrl(deps: ToolHubDeps, vendor: Model3dVendorConfig, value: string, label: string): Promise<string> {
  const comma = value.indexOf(",", 5);
  if (comma < 0) throw new MediaUpstreamError(`${label} data: URL is malformed (missing header/data comma)`, "param");
  const header = value.slice(5, comma);
  if (!header.trimEnd().toLowerCase().endsWith(";base64")) {
    throw new MediaUpstreamError(`${label} data: URL must be base64 encoded (data:image/png;base64,...)`, "param");
  }
  // image/jpg → image/jpeg alias (plugin IMAGE_MIME maps .jpg to image/jpeg both ways).
  const rawMime = header.slice(0, header.indexOf(";")).trim().toLowerCase();
  const mime = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
  const extension = IMAGE_DATA_MIME[mime];
  if (!extension) throw new MediaUpstreamError(`${label} data: URL only supports png / jpeg / webp`, "param");
  const encoded = value.slice(comma + 1).replace(/[ \t\r\n\f]+/g, "");
  // 严格 base64 结构校验（同 seed-image.ts：Buffer.from 宽容解码会静默吃掉
  // 非法字符，坏输入必须本地 400 而不是把垃圾字节传给上游）。
  let end = encoded.length;
  while (end > 0 && encoded.charCodeAt(end - 1) === 61 /* = */) end--;
  const base = encoded.slice(0, end);
  const padding = encoded.length - end;
  const wellFormed = /^[A-Za-z0-9+/]*$/.test(base) && base.length % 4 !== 1 && (padding === 0 || (padding <= 2 && encoded.length % 4 === 0));
  if (!wellFormed) {
    throw new MediaUpstreamError(`${label} data: URL is not valid standard base64 (URL-safe alphabets, percent-encoding and broken padding are not accepted)`, "param");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!bytes.length) throw new MediaUpstreamError(`${label} data: URL content is empty`, "param");
  if (bytes.length > vendor.maxImageBytes) {
    throw new MediaUpstreamError(`${label} exceeds the vendor's ${Math.floor(vendor.maxImageBytes / (1024 * 1024))} MiB image cap`, "param");
  }
  return uploadFile(deps, bytes, mime, `reference${extension}`);
}

export interface Model3dTaskResponse {
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  files?: Array<{ name: string; url: string }>;
  error?: { code: string; message: string };
}

export async function createModel3dTask(
  deps: ToolHubDeps,
  vendor: string,
  raw: Record<string, unknown>,
): Promise<TaskSubmitResponse> {
  const config = MODEL3D_VENDORS[vendor];
  const requestId = typeof raw.request_id === "string" && raw.request_id.trim() ? raw.request_id.trim() : undefined;
  if (requestId !== undefined && !/^[!-~]{1,128}$/.test(requestId)) {
    throw new MediaUpstreamError("request_id must be 1-128 printable ASCII characters", "param");
  }
  const scenario = { ...deps, usageScenario: config.usageScenario };
  const body = await prepareModel3dBody(scenario, config, raw);
  const { taskId } = await submitToolhubTask(scenario, config.tool, body, requestId);
  return { task_id: taskId, status: "queued" };
}

function httpUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim()) ? value.trim() : undefined;
}

/** Deep-collect `{name,url}` pairs from any nested result structure (meshy `output.result`). */
function collectResultUrls(value: unknown, key: string, out: Array<{ name: string; url: string }>): void {
  const url = httpUrl(value);
  if (url) {
    out.push({ name: key, url });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectResultUrls(item, `${key}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectResultUrls(child, key ? `${key}.${childKey}` : childKey, out);
    }
  }
}

/**
 * Per-vendor success products (each plugin parses a different shape):
 *   hyper3d — `output.files[]` of {name,url} (+ top-level `files` fallback);
 *   meshy   — `output.model_urls` map + deep URLs inside `output.result`
 *             (thumbnail_url is NOT a model product per the plugin);
 *   hi3d    — `output.url` (model) + optional `output.cover_url`.
 * Mirrors the plugins' "succeeded but products not written yet → keep polling":
 * an empty product list maps to "running", never a 502.
 */
function model3dProducts(vendor: string, output: Record<string, unknown>): Array<{ name: string; url: string }> {
  if (vendor === "hyper3d") {
    const rawFiles = Array.isArray(output.files) ? output.files : undefined;
    if (!rawFiles) return [];
    return rawFiles
      .filter((file): file is Record<string, unknown> => !!file && typeof file === "object" && httpUrl((file as Record<string, unknown>).url) !== undefined)
      .map((file) => ({
        name: typeof file.name === "string" ? file.name : "",
        url: httpUrl(file.url)!,
      }));
  }
  if (vendor === "meshy") {
    const files: Array<{ name: string; url: string }> = [];
    const modelUrls = output.model_urls;
    if (modelUrls && typeof modelUrls === "object" && !Array.isArray(modelUrls)) {
      for (const [name, value] of Object.entries(modelUrls as Record<string, unknown>)) {
        const url = httpUrl(value);
        if (url) files.push({ name, url });
      }
    }
    collectResultUrls(output.result, "result", files);
    return files;
  }
  // hi3d
  const model = httpUrl(output.url);
  if (!model) return [];
  const files: Array<{ name: string; url: string }> = [{ name: "model", url: model }];
  const cover = httpUrl(output.cover_url);
  if (cover) files.push({ name: "cover", url: cover });
  return files;
}

export async function getModel3dTask(deps: ToolHubDeps, vendor: string, taskId: string): Promise<Model3dTaskResponse> {
  const config = MODEL3D_VENDORS[vendor];
  const snapshot = await queryToolhubTask({ ...deps, usageScenario: config.usageScenario }, config.tool, taskId);
  if (snapshot.status === "succeeded") {
    const files = model3dProducts(vendor, snapshot.output);
    if (!files.length) {
      // Plugin contract: the upstream flips status before writing products —
      // keep the caller polling instead of failing a charged task.
      return { task_id: taskId, status: "running" };
    }
    return { task_id: taskId, status: "succeeded", files };
  }
  if (snapshot.status === "failed") {
    return {
      task_id: taskId,
      status: "failed",
      error: { code: snapshot.failure?.code ?? "upstream_failure", message: snapshot.failure?.message ?? "model generation failed upstream" },
    };
  }
  return { task_id: taskId, status: "running" };
}
