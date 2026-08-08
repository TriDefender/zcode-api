/**
 * Minimal MCP (Model Context Protocol) JSON-RPC client for GLM's remote MCP
 * servers. Designed for the GLM wire shape verified by live probing (see
 * `_reverse/NOTEPAD.md` and the exploration notes):
 *
 *   - Transport: Streamable HTTP over POST; responses are ALWAYS
 *     `text/event-stream` (server ignores `Accept: application/json`).
 *   - Each SSE frame is a 3-line block:
 *       `id:1`  (SSE event id, fixed — NOT the JSON-RPC id, ignore it)
 *       `event:message`
 *       `data:{<json-rpc payload>}`
 *   - Sessions are mandatory: `initialize` returns `Mcp-Session-Id`, and every
 *     subsequent request MUST carry it back as a header.
 *   - Protocol version: client sends `2025-06-18`; server downgrades to
 *     `2024-11-05`. We accept whatever the server returns.
 *   - `notifications/initialized` must be sent once after `initialize` (HTTP
 *     200 with empty body, no SSE).
 *   - Auth failure returns HTTP 200 with a non-JSON-RPC envelope:
 *       `{"code":1001,"msg":"...","success":false}` (not a JSON-RPC error) —
 *     the client detects this and throws `McpAuthError`.
 *   - Tool results carry a `content[]` array of `{type:"text",text}` blocks;
 *     some tools (web_search_prime) return a *doubly-encoded* JSON string in
 *     `text` (a stringified JSON array) — the caller decodes.
 *
 * No external dependencies. Pure `fetch()`. Works on both Bun and Node.
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 * @see https://modelcontextprotocol.io/specification/2025-06-18/server/tools
 */
import type { ProviderId } from "../provider/types.js";

/** MCP tool definition (subset we care about). */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Result of a successful tools/call. */
export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType?: string }>;
  isError: boolean;
}

/** Thrown when the server returns the non-JSON-RPC auth envelope. */
export class McpAuthError extends Error {
  readonly code: number;
  constructor(code: number, msg: string) {
    super(`MCP auth error (code=${code}): ${msg}`);
    this.name = "McpAuthError";
    this.code = code;
  }
}

/** Thrown when the server returns a JSON-RPC `error` object. */
export class McpRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`MCP RPC error (code=${code}): ${message}`);
    this.name = "McpRpcError";
    this.code = code;
  }
}

export interface McpClientOptions {
  /** Full MCP endpoint URL, e.g. `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`. */
  url: string;
  /** Bearer credential — same GLM API key used for the LLM upstream. */
  apiKey: string;
  /** Protocol version to advertise in `initialize`; default `2025-06-18`. */
  protocolVersion?: string;
  /** Per-request timeout in ms; default 30000. */
  timeoutMs?: number;
  /** DI seam for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Stateless-per-instance is forbidden by GLM (session is required), so a client
 * owns its session. One instance per (server, apiKey) — pool via `GlmMcpPool`.
 */
export class McpClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly protocolVersion: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private sessionId: string | undefined;
  private nextId = 1;
  private initialized = false;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.protocolVersion = opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Perform the MCP handshake: `initialize` (captures session id) +
   * `notifications/initialized`. Idempotent — subsequent calls are no-ops.
   * Called lazily by `listTools` / `callTool`.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const initResp = await this.postRpc("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "zcode-proxy", version: "2.2.0" },
    });
    const result = initResp.json.result as { protocolVersion?: string } | undefined;
    // GLM downgrades the version; we accept the server's choice silently.
    void result?.protocolVersion;
    this.initialized = true;
    // notifications/initialized has no response body; swallow the empty SSE.
    try {
      await this.postRpc("notifications/initialized", undefined);
    } catch {
      // Some servers return empty bodies that fail SSE parse — safe to ignore.
    }
  }

  /** List the tools the server exposes. */
  async listTools(): Promise<McpToolDef[]> {
    await this.initialize();
    const resp = await this.postRpc("tools/list", {});
    const result = resp.json.result as { tools?: McpToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  /** Invoke a tool. Returns the raw `content[]`; callers decode per-tool. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    await this.initialize();
    const resp = await this.postRpc("tools/call", { name, arguments: args });
    const result = resp.json.result as McpToolCallResult | undefined;
    if (!result || !Array.isArray(result.content)) {
      throw new McpRpcError(-32603, `tool "${name}" returned malformed result`);
    }
    return result;
  }

  /** Drop the session. Next call re-initializes. Safe to call when not initialized. */
  reset(): void {
    this.sessionId = undefined;
    this.initialized = false;
  }

  /**
   * Send a JSON-RPC request and parse the SSE response. For notifications
   * (no `id`) the response is empty — the parser tolerates a 0-event stream.
   */
  private async postRpc(
    method: string,
    params: unknown,
  ): Promise<{ json: JsonRpcResponse; headers: Headers }> {
    const id = method.startsWith("notifications/") ? undefined : this.nextId++;
    const body: string = JSON.stringify({
      jsonrpc: "2.0",
      ...(id !== undefined ? { id } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let httpResp: Response;
    try {
      httpResp = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.apiKey}`,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!httpResp.ok) {
      throw new McpRpcError(-32000, `HTTP ${httpResp.status} ${httpResp.statusText}`);
    }

    // Capture the session id on the FIRST response (initialize).
    if (!this.sessionId) {
      const sid = httpResp.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }

    const contentType = httpResp.headers.get("content-type") ?? "";
    const raw = await httpResp.text();

    // GLM's auth failures are HTTP 200 + a non-JSON-RPC envelope.
    if (!contentType.includes("event-stream") && !contentType.includes("application/json")) {
      // Still inspect the body — some auth failures come back without a proper CT.
      throw this.classifyEnvelope(raw);
    }

    // Empty body (notifications/initialized) → no JSON-RPC payload to return.
    if (raw.length === 0 || raw.trim() === "") {
      return { json: { jsonrpc: "2.0" }, headers: httpResp.headers };
    }

    const payload = contentType.includes("event-stream")
      ? parseSseFrame(raw)
      : safeParseJson(raw);

    if (payload === null) {
      // Could be the auth envelope on a 200 with no/odd CT.
      throw this.classifyEnvelope(raw);
    }

    // Detect GLM's auth envelope even when it leaks into a JSON-looking CT.
    if (
      typeof payload === "object"
      && payload !== null
      && "success" in payload
      && payload.success === false
      && typeof (payload as { code?: unknown }).code === "number"
      && !("jsonrpc" in payload)
    ) {
      const env = payload as unknown as { code: number; msg?: string };
      throw new McpAuthError(env.code, env.msg ?? "auth failed");
    }

    const jsonRpc = payload as JsonRpcResponse;
    if (jsonRpc.error) {
      throw new McpRpcError(jsonRpc.error.code, jsonRpc.error.message);
    }
    return { json: jsonRpc, headers: httpResp.headers };
  }

  /** Parse a body as JSON; if it looks like GLM's `{code, msg, success:false}` envelope, return the right error. */
  private classifyEnvelope(raw: string): Error {
    const parsed = safeParseJson(raw);
    if (
      parsed !== null
      && typeof parsed === "object"
      && parsed !== null
      && "success" in parsed
      && (parsed as { success?: unknown }).success === false
      && typeof (parsed as { code?: unknown }).code === "number"
    ) {
      const env = parsed as unknown as { code: number; msg?: string };
      return new McpAuthError(env.code, env.msg ?? "auth failed");
    }
    return new McpRpcError(-32700, `unparseable MCP response (content-type missing, body: ${raw.slice(0, 200)})`);
  }
}

/**
 * Parse one SSE frame from GLM's response into a JSON value.
 *
 * GLM emits exactly one `data:` line per response, so this is simpler than a
 * full streaming parser. The frame shape (verified by probing):
 *
 *     id:1
 *     event:message
 *     data:{"jsonrpc":"2.0",...}
 *
 * `id:1` is the SSE event id (fixed at 1 by the server — not the JSON-RPC id).
 * We ignore it and parse only the `data:` payload.
 */
function parseSseFrame(raw: string): unknown {
  let dataLine: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      // GLM uses `data:{...}` (no space). Tolerate both forms.
      dataLine = line.slice(5).replace(/^\s/, "");
      break;
    }
  }
  if (dataLine === null) return null;
  return safeParseJson(dataLine);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Provider-aware endpoint derivation
// ─────────────────────────────────────────────

/** GLM MCP host per provider (verified: both providers serve identical MCP shapes). */
const MCP_HOSTS: Record<ProviderId, string> = {
  bigmodel: "https://open.bigmodel.cn",
  zai: "https://api.z.ai",
};

/** GLM MCP server identifiers. Path is `/api/mcp/{server}/mcp` for both providers. */
export type GlmMcpServerId = "web_search_prime" | "web_reader" | "zread";

/** Build the full MCP endpoint URL for a (provider, server) pair. */
export function glmMcpEndpoint(provider: ProviderId, server: GlmMcpServerId): string {
  return `${MCP_HOSTS[provider]}/api/mcp/${server}/mcp`;
}
