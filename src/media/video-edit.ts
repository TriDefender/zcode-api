/**
 * video_edit official-MCP client — the speech plane behind the video-agent-kit
 * plugin. Under the official host, the plugin's ve_tools/zcode_speech.py calls
 * `POST {ZCODE_BASE_URL}/api/v1/mcp/server/video_edit` (Streamable HTTP MCP,
 * stateless) with the identity headers injected per tools/call; here the same
 * headers come from `buildOfficialMcpAuthHeaders`.
 *
 * Four server facts verified from the plugin source (2026-11-14, all
 * commented there as "都核过源码，改动前先复核"):
 *   1. Body cap 45 MiB at the entry nginx (client_max_body_size; the go-sdk
 *      layer allows 50 MiB) — enforced at our route layer;
 *   2. EVERY field of SpeechTranscribeRequest (8) / SpeechSynthesizeRequest
 *      (11) is required — the server dropped all `omitempty` (zcode-server
 *      commit b1c7283), so payloads are built complete, zero-values included;
 *   3. HTTP details: POST only; `Content-Type: application/json`; `Accept`
 *      must carry BOTH application/json and text/event-stream (missing one →
 *      400); responses are SSE frames (server does not enable JSONResponse)
 *      — decode with the shared `decodeSseFrame`; stateless go-sdk synthesizes
 *      initialize/initialized internally, so a bare `tools/call` works with
 *      NO handshake and NO `Mcp-Session-Id`;
 *   4. The URL must not carry a trailing slash (`…/video_edit/` → 307).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"（同款头契约/网关）
 */
import { decodeSseFrame, McpUpstreamError } from "../mcp/upstream.js";
import { MediaUpstreamError } from "./shared.js";

export interface VideoEditDeps {
  origin: string;
  /** Official identity headers (Authorization + X-Bigmodel-Authorization + …). */
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

export interface VideoEditCallResult {
  data: Record<string, unknown>;
  /** Upstream-generated request id (x-request-id) — the only log-reconciliation key. */
  requestId?: string;
}

interface JsonRpcResult {
  result?: { isError?: unknown; structuredContent?: unknown; content?: unknown };
  error?: { code?: unknown; message?: unknown };
}

export class VideoEditClient {
  constructor(private readonly deps: VideoEditDeps) {}

  /**
   * Bare `tools/call` against the stateless video_edit MCP server. Blocks
   * until the tool completes (speech_transcribe can run minutes for long
   * audio — callers pass an appropriate timeoutMs).
   */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<VideoEditCallResult> {
    let resp: Response;
    try {
      resp = await this.deps.fetchImpl(`${this.deps.origin}/api/v1/mcp/server/video_edit`, {
        method: "POST",
        headers: {
          ...this.deps.headers,
          "content-type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        // 身份头禁止跨 origin 重定向；3xx = URL 拼错（如尾斜杠）。
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new MediaUpstreamError(`speech tool "${name}" timed out upstream`, "upstream");
      }
      throw new MediaUpstreamError(`speech gateway unreachable: ${(err as Error).message}`, "upstream");
    }

    const requestId = resp.headers.get("x-request-id") ?? undefined;
    if (resp.status === 401) throw new MediaUpstreamError("speech gateway rejected the credential (HTTP 401) — re-run `auth login`", "auth");
    if (resp.status === 403) throw new MediaUpstreamError("speech gateway denied access (HTTP 403) — the account lacks this entitlement", "forbidden");
    if (resp.status === 413) throw new MediaUpstreamError("speech gateway rejected the request body as too large (45 MiB nginx cap)", "too_large");
    if (resp.status === 429) throw new MediaUpstreamError("speech gateway rate limited the request (HTTP 429)", "rate_limit");
    if (resp.status >= 300 && resp.status < 400) {
      throw new MediaUpstreamError("speech gateway returned a redirect — the endpoint must be a canonical URL without a trailing slash", "upstream");
    }

    const contentType = resp.headers.get("content-type") ?? "";
    let payload: JsonRpcResult;
    try {
      const text = await resp.text();
      payload = contentType.includes("text/event-stream")
        ? (decodeSseFrame(text, 1) as JsonRpcResult)
        : (JSON.parse(text) as JsonRpcResult);
    } catch (err) {
      if (err instanceof McpUpstreamError) {
        throw new MediaUpstreamError(`speech gateway response had no JSON-RPC frame${requestId ? ` (x-request-id ${requestId})` : ""}`, "upstream");
      }
      if (resp.status >= 400) {
        throw new MediaUpstreamError(`speech gateway request failed: HTTP ${resp.status}`, "upstream");
      }
      throw new MediaUpstreamError(`speech gateway returned an unrecognizable response${requestId ? ` (x-request-id ${requestId})` : ""}`, "upstream");
    }

    if (payload.error && typeof payload.error === "object") {
      throw new MediaUpstreamError(
        `speech gateway JSON-RPC error ${String(payload.error.code)}: ${String(payload.error.message)}`,
        "upstream",
      );
    }
    const result = payload.result;
    if (!result || typeof result !== "object") {
      throw new MediaUpstreamError("speech gateway response carried no result", "upstream");
    }
    if (result.isError === true) {
      throw new MediaUpstreamError(`speech tool "${name}" failed: ${resultText(result.content) || "no detail"}`, "upstream");
    }
    const data = resultData(result);
    if (!data) {
      throw new MediaUpstreamError(`speech tool "${name}" returned no structured content`, "upstream");
    }
    return { data, ...(requestId ? { requestId } : {}) };
  }
}

/** structuredContent first; fallback: typed tools also write JSON into the text content. */
function resultData(result: { structuredContent?: unknown; content?: unknown }): Record<string, unknown> | undefined {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = resultText(result.content);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}
