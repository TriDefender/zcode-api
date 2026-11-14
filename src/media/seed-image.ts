/**
 * Seedream-compatible image generation face (`POST /api/v3/images/generations`)
 * → ToolHub `image_generate/invoke` translation.
 *
 * Upstream reality (image-generation/0.1.1/mcp/server.mjs): ToolHub supports
 * exactly ONE reference image (`image` param), accepts only https references,
 * and returns a single `output.image_url`. Official Seedream fields without a
 * ToolHub counterpart (`size`, `seed`, `guidance_scale`, `watermark`,
 * `sequential_image_generation*`) are accepted and IGNORED — deliberate
 * deviation, pinned in parseSeedImageRequest so callers can detect it.
 *
 * @see src/media/toolhub.ts（invokeImage / uploadFile 语义来源）
 */
import { MediaUpstreamError, type MediaUpstreamKind } from "./shared.js";
import { invokeImage, uploadFile, type ToolHubDeps } from "./toolhub.js";

export interface SeedImageRequest {
  model?: string;
  prompt: string;
  /** Single https/data: reference; arrays collapse to one element or fail. */
  image?: string;
  responseFormat: "url" | "b64_json";
}

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** Parse + validate the Ark-shaped request. Pure — direct-tested. */
export function parseSeedImageRequest(body: unknown): { ok: true; req: SeedImageRequest } | { ok: false; kind: MediaUpstreamKind; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, kind: "param", message: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, kind: "param", message: "prompt is required and must be a non-empty string" };
  }
  let image: string | undefined;
  if (raw.image !== undefined && raw.image !== null) {
    if (typeof raw.image === "string") {
      image = raw.image.trim();
    } else if (Array.isArray(raw.image)) {
      const items = raw.image.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      // ToolHub image_generate accepts exactly one reference image (plugin:
      // `body = image ? { query, image } : { query }`). More than one → fail
      // loudly instead of silently dropping references.
      if (items.length > 1) {
        return { ok: false, kind: "param", message: "the upstream supports a single reference image; pass image as one URL (merge multiple references on the caller side)" };
      }
      image = items[0];
    } else {
      return { ok: false, kind: "param", message: "image must be a URL string (or a single-element array of URLs)" };
    }
  }
  let responseFormat: "url" | "b64_json" = "url";
  if (raw.response_format !== undefined && raw.response_format !== null) {
    if (raw.response_format !== "url" && raw.response_format !== "b64_json") {
      return { ok: false, kind: "param", message: 'response_format must be "url" or "b64_json"' };
    }
    responseFormat = raw.response_format;
  }
  return {
    ok: true,
    req: {
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      prompt,
      ...(image ? { image } : {}),
      responseFormat,
    },
  };

}

/** https only, no credentials, no whitespace/control characters (mirror plugin httpsHref). */
function httpsHref(value: string): string | undefined {
  if (/[\s\p{Cc}]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : undefined;
}

/**
 * data:image/...;base64 → upload to ToolHub files for a presigned https URL
 * (ToolHub references are https-only since 2025-11-08 — plugin comment
 * "ToolHub 自 11-08 起参考图只收 https，data: URL 先经上传接口换成预签名地址").
 */
async function resolveReference(deps: ToolHubDeps, image: string): Promise<string> {
  if (/^https:\/\//i.test(image)) {
    const href = httpsHref(image);
    if (!href) throw new MediaUpstreamError("reference image URL must be a valid https URL (no whitespace or credentials)", "param");
    return href;
  }
  if (/^data:/i.test(image)) return uploadDataUrl(deps, image);
  throw new MediaUpstreamError("reference image must be an https URL or a data:image/...;base64 URL (http, file: and bare paths are not accepted)", "param");
}

async function uploadDataUrl(deps: ToolHubDeps, value: string): Promise<string> {
  const comma = value.indexOf(",", 5);
  if (comma < 0) throw new MediaUpstreamError("data: reference image is malformed (missing header/data comma)", "param");
  const header = value.slice(5, comma);
  if (!header.trimEnd().toLowerCase().endsWith(";base64")) {
    throw new MediaUpstreamError("data: reference image must be base64 encoded (data:image/png;base64,...)", "param");
  }
  const mime = header.slice(0, header.indexOf(";")).trim().toLowerCase();
  const resolvedMime = mime === "image/jpg" ? "image/jpeg" : mime;
  const extension = resolvedMime === "image/png" ? ".png" : resolvedMime === "image/webp" ? ".webp" : resolvedMime === "image/jpeg" ? ".jpg" : undefined;
  if (!extension) throw new MediaUpstreamError("data: reference image only supports png / jpeg / webp", "param");
  const encoded = value.slice(comma + 1).replace(/[ \t\r\n\f]+/g, "");
  // 镜像插件的严格 base64 结构校验（image-generation server.mjs）：Buffer.from
  // 会静默丢掉非法字符，URL-safe 字母表/坏 padding 不在这里拦住，就会解成垃圾
  // 字节上传 ToolHub——一次费解的上游失败，而不是干净的 400。线性检查（尾数填充
  // 计数 + 无分组的字符集正则），不做会平方级回溯的重正则。
  let end = encoded.length;
  while (end > 0 && encoded.charCodeAt(end - 1) === 61 /* = */) end--;
  const body = encoded.slice(0, end);
  const padding = encoded.length - end;
  const wellFormed = /^[A-Za-z0-9+/]*$/.test(body) && body.length % 4 !== 1 && (padding === 0 || (padding <= 2 && encoded.length % 4 === 0));
  if (!wellFormed) {
    throw new MediaUpstreamError("data: reference image is not valid standard base64 (URL-safe alphabets, percent-encoding and broken padding are not accepted)", "param");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!bytes.length) throw new MediaUpstreamError("data: reference image content is empty", "param");
  if (bytes.length > MAX_REFERENCE_BYTES) throw new MediaUpstreamError("reference image exceeds 10 MiB", "param");
  return uploadFile(deps, bytes, resolvedMime, `reference${extension}`);
}

/** Download the generated image for response_format:"b64_json" (manual redirects, 64 MiB cap). */
export async function downloadImageAsBase64(fetchImpl: typeof fetch, imageUrl: string): Promise<string> {
  let url = imageUrl;
  for (let hop = 0; ; hop += 1) {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      throw new MediaUpstreamError(`generated image download failed: ${(err as Error).message}`, "upstream");
    }
    if (resp.status >= 300 && resp.status < 400) {
      if (hop >= 3) throw new MediaUpstreamError("generated image download exceeded the redirect limit", "upstream");
      const location = resp.headers.get("location");
      if (!location) throw new MediaUpstreamError("generated image redirect carried no location", "upstream");
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new MediaUpstreamError("generated image redirect carried an unparseable location", "upstream");
      }
      if (!httpsHref(next)) throw new MediaUpstreamError("generated image redirect left the https origin — refusing to follow", "upstream");
      await resp.body?.cancel().catch(() => {});
      url = next;
      continue;
    }
    if (!resp.ok) throw new MediaUpstreamError(`generated image download failed (HTTP ${resp.status})`, "upstream");
    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new MediaUpstreamError("generated image exceeds the 64 MiB download cap", "too_large");
    }
    const buffer = new Uint8Array(await resp.arrayBuffer());
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES) throw new MediaUpstreamError("generated image exceeds the 64 MiB download cap", "too_large");
    return Buffer.from(buffer).toString("base64");
  }
}

export interface SeedImageResponse {
  model: string;
  created: number;
  data: Array<{ url: string } | { b64_json: string }>;
  usage: { generated_images: number };
  invocationId?: string;
}

export async function generateImage(deps: ToolHubDeps, fetchImpl: typeof fetch, req: SeedImageRequest): Promise<SeedImageResponse> {
  const toolhubBody: { query: string; image?: string } = { query: req.prompt };
  if (req.image) toolhubBody.image = await resolveReference(deps, req.image);
  const { imageUrl, invocationId } = await invokeImage(deps, toolhubBody);
  const item = req.responseFormat === "b64_json" ? { b64_json: await downloadImageAsBase64(fetchImpl, imageUrl) } : { url: imageUrl };
  return {
    model: req.model ?? "doubao-seedream",
    created: Math.floor(Date.now() / 1000),
    data: [item],
    usage: { generated_images: 1 },
    ...(invocationId ? { invocationId } : {}),
  };
}
