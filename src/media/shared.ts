/**
 * Seed 系媒体兼容面共享件：Ark 形错误体、凭据门禁、带上限的请求体读取。
 *
 * 四个火山官方形状的 REST 面（`/api/v3/images/generations`、
 * `/api/v3/contents/generations/tasks`、`/api/v3/auc/bigmodel/recognize/flash`、
 * `/api/v3/tts/create`）对内都翻译成 ZCode 自己的 ToolHub REST 与官方
 * Server MCP（`/api/v1/mcp/server/video_edit`）调用。出站鉴权与 /mcp 面
 * 同配方（`buildOfficialMcpAuthHeaders`：Authorization Bearer JWT +
 * X-Bigmodel-Authorization Bearer coding-plan key + Bigmodel-Target-Type
 * PERSONAL）——这正是官方插件在每次 tools/call 的
 * `_meta["com.zcode/official-mcp-auth"]` 里收到的同一套身份头。
 *
 * Start Plan / API-key 连接在宿主侧就报 `official_auth_plan_required`
 * 拒发身份（网关终审 3101 "coding plan is required"），所以这里同 /mcp、
 * /async 一样显式 400，不做无谓的上游往返。
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"（头契约实弹版）
 * @see 官方插件实现（机制事实来源，2026-11-14 通读）：
 *   video-agent-kit/0.4.3/mcp/ve_tools/{zcode_speech,cloud_asr,tts,official_auth}.py
 *   image-generation/0.1.1/mcp/server.mjs + video-generation/0.2.0/mcp/server.mjs
 */
import { buildOfficialMcpAuthHeaders, McpCredentialsUnavailableError, type OfficialMcpAuth } from "../mcp/upstream.js";
import type { Credential } from "../auth/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";

export type MediaCredentialReason = "not_logged_in" | "plan_unsupported" | "missing_jwt";

export type MediaAuthStatus =
  | { ok: true; auth: OfficialMcpAuth }
  | { ok: false; reason: MediaCredentialReason; message: string };

/**
 * ToolHub 与 video_edit 两个平面的门禁完全一致（同一套身份头），所以四个
 * 兼容面共用这一个判定。镜像 routes-mcp.ts::resolveMcpAuth。
 */
export function resolveMediaAuth(cred: Credential | null, plan: ProxyConfig["plan"]): MediaAuthStatus {
  if (plan !== "coding-plan") {
    return {
      ok: false,
      reason: "plan_unsupported",
      message: `the media endpoints require plan "coding-plan" (current plan: ${plan})`,
    };
  }
  if (!cred) {
    return {
      ok: false,
      reason: "not_logged_in",
      message: "not logged in — run: zcode-proxy auth login <zai|bigmodel>",
    };
  }
  try {
    return { ok: true, auth: buildOfficialMcpAuthHeaders(cred) };
  } catch (err) {
    if (err instanceof McpCredentialsUnavailableError) {
      return { ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

/** 从 AuthManager 取凭据并过门禁；未登录（getCredential 抛错）按 null 处理。 */
export async function resolveMediaAuthFrom(auth: AuthManager, plan: ProxyConfig["plan"]): Promise<MediaAuthStatus> {
  let cred: Credential | null = null;
  try {
    cred = await auth.getCredential();
  } catch {
    cred = null;
  }
  return resolveMediaAuth(cred, plan);
}

/**
 * 火山 Ark 形错误体：`{"error":{"code":"<string>","message":…}}`。
 * 注意与 proxy/handler.ts errorResponse 的 `{error:{type,…}}` 是两种形状——
 * 这四个面要被按火山官方文档解析的第三方客户端消费，code 必须是字符串。
 */
export function arkErrorResponse(status: number, code: string, message: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...(extraHeaders ?? {}) },
  });
}

export type MediaUpstreamKind =
  | "auth" // 上游 401（JWT 失效）
  | "forbidden" // 上游 403（账号无该权益，如 3706 手机绑定）
  | "too_large" // 体限（本地 413 或上游 413）
  | "rate_limit" // 3002 / HTTP 429
  | "param" // 3001 / 3707 / 本地参数校验
  | "not_found" // 3704 任务不存在/过期
  | "unavailable" // 3701/3705 服务未开放
  | "upstream"; // 其余（网络/5xx/无法解析）

/** 上游调用失败。seed 模块抛出，routes 层按 kind 映射为 Ark 错误面。 */
export class MediaUpstreamError extends Error {
  constructor(
    message: string,
    public readonly kind: MediaUpstreamKind,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MediaUpstreamError";
  }
}

/** kind → (HTTP status, Ark code)。集中一处，别让 routes 层散落映射。 */
export function arkErrorFor(err: MediaUpstreamError): Response {
  const table: Record<MediaUpstreamKind, { status: number; code: string }> = {
    auth: { status: 502, code: "upstream_auth_rejected" },
    forbidden: { status: 502, code: "upstream_permission_denied" },
    too_large: { status: 413, code: "request_too_large" },
    rate_limit: { status: 429, code: "rate_limit_exceeded" },
    param: { status: 400, code: "invalid_parameter" },
    not_found: { status: 404, code: "not_found" },
    unavailable: { status: 502, code: "upstream_unavailable" },
    upstream: { status: 502, code: "upstream_error" },
  };
  const mapped = table[err.kind];
  return arkErrorResponse(mapped.status, mapped.code, err.message);
}

/** 请求体超限（本地体限，镜像 async 的 content-length 预检 + 流式计数模式）。 */
export class MediaBodyTooLargeError extends Error {
  constructor(
    public readonly maxBytes: number,
    message?: string,
  ) {
    super(message ?? `request body exceeds ${maxBytes} bytes`);
    this.name = "MediaBodyTooLargeError";
  }
}

/**
 * 读取 JSON 请求体，超 maxBytes 抛 MediaBodyTooLargeError。
 * content-length 预检先拒（不读流），再边读边计数兜底（声明撒谎时拦住）。
 */
export async function readJsonBodyWithCap(req: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaBodyTooLargeError(maxBytes);
  }
  const reader = req.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MediaBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(concatChunks(chunks, total));
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new MediaUpstreamError("request body is not valid JSON", "param");
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
