/**
 * GLM MCP server registry + tool-call wrappers for the three official remote
 * MCP servers (web_search_prime / web_reader / zread). All three use the same
 * GLM API key as the LLM upstream, and their endpoints are derived from the
 * active provider (see `glmMcpEndpoint`).
 *
 * Used by the Responses handler to:
 *   - intercept `web_search` / `web_search_preview` hosted tools and route
 *     them to GLM's `web_search_prime` MCP tool,
 *   - (P2, off by default) inject `web_reader` / `zread` as function tools the
 *     model can call directly.
 *
 * Each wrapper decodes the MCP result into a typed shape. `web_search_prime` is
 * the trickiest: its `content[0].text` is a *doubly-encoded* JSON string (a
 * stringified JSON array). The wrapper does `JSON.parse` once to unwrap the
 * array, leaving consumers with a clean `WebSearchHit[]`.
 */
import { McpClient, glmMcpEndpoint, type GlmMcpServerId, type McpClientOptions } from "./client.js";
import type { ProviderId } from "../provider/types.js";

// ─────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────

export interface WebSearchHit {
  title: string;
  link: string;
  content: string;
  /** GLM's per-result reference id (e.g. "ref_1"). */
  refer?: string;
}

export interface WebPageContent {
  /** Decoded page content (markdown or text, per `return_format`). */
  text: string;
  /** Raw MCP content blocks (preserved for future field extraction). */
  raw: Array<{ type: string; text?: string }>;
}

export interface ZreadSearchResult {
  // GLM zread returns free-form text content; keep it loose.
  text: string;
}

export interface ZreadRepoStructure {
  text: string;
}

export interface ZreadFileContent {
  text: string;
}

// ─────────────────────────────────────────────
// Pool: one McpClient per (provider, server) — reuses the session.
// ─────────────────────────────────────────────

export interface GlmMcpPoolOptions {
  provider: ProviderId;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Lazily-initialised pool of MCP clients keyed by server id. Reuses sessions
 * across calls (GLM sessions are stateful and expensive to re-establish).
 * Call `close()` on shutdown to reset all sessions (best-effort).
 */
export class GlmMcpPool {
  private readonly opts: GlmMcpPoolOptions;
  private readonly clients = new Map<GlmMcpServerId, McpClient>();

  constructor(opts: GlmMcpPoolOptions) {
    this.opts = opts;
  }

  private client(server: GlmMcpServerId): McpClient {
    let c = this.clients.get(server);
    if (!c) {
      const clientOpts: McpClientOptions = {
        url: glmMcpEndpoint(this.opts.provider, server),
        apiKey: this.opts.apiKey,
        fetchImpl: this.opts.fetchImpl,
        timeoutMs: this.opts.timeoutMs,
      };
      c = new McpClient(clientOpts);
      this.clients.set(server, c);
    }
    return c;
  }

  /** Reset all cached sessions (e.g. on credential rotation). */
  reset(): void {
    for (const c of this.clients.values()) c.reset();
  }

  // ── web_search_prime ──
  /**
   * Search the web via GLM's MCP. `arguments` mirror GLM's inputSchema
   * (verified by live `tools/list`):
   *   - `search_query` (required)
   *   - `search_domain_filter`, `search_recency_filter`, `content_size`, `location`
   */
  async webSearch(args: {
    search_query: string;
    search_domain_filter?: string;
    search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
    content_size?: "medium" | "high";
    location?: "cn" | "us";
  }): Promise<WebSearchHit[]> {
    const result = await this.client("web_search_prime").callTool("web_search_prime", args as Record<string, unknown>);
    return decodeWebSearchResult(result.content);
  }

  // ── web_reader ──
  /** Fetch a URL's content via GLM's MCP `webReader` tool. */
  async webRead(args: {
    url: string;
    return_format?: "markdown" | "text";
    no_cache?: boolean;
    retain_images?: boolean;
    no_gfm?: boolean;
    with_images_summary?: boolean;
    with_links_summary?: boolean;
    timeout?: number;
  }): Promise<WebPageContent> {
    const result = await this.client("web_reader").callTool("webReader", args as Record<string, unknown>);
    return { text: joinText(result.content), raw: result.content as Array<{ type: string; text?: string }> };
  }

  // ── zread ──
  /** Search a GitHub repo's docs/issues/commits via GLM's `zread` MCP. */
  async zreadSearchDoc(args: { repo_name: string; query: string; language?: "zh" | "en" }): Promise<ZreadSearchResult> {
    const result = await this.client("zread").callTool("search_doc", args as Record<string, unknown>);
    return { text: joinText(result.content) };
  }

  /** Get a GitHub repo's directory structure via GLM's `zread` MCP. */
  async zreadGetRepoStructure(args: { repo_name: string; dir_path?: string }): Promise<ZreadRepoStructure> {
    const result = await this.client("zread").callTool("get_repo_structure", args as Record<string, unknown>);
    return { text: joinText(result.content) };
  }

  /** Read a file in a GitHub repo via GLM's `zread` MCP. */
  async zreadReadFile(args: { repo_name: string; file_path: string }): Promise<ZreadFileContent> {
    const result = await this.client("zread").callTool("read_file", args as Record<string, unknown>);
    return { text: joinText(result.content) };
  }
}

// ─────────────────────────────────────────────
// Decoders
// ─────────────────────────────────────────────

/**
 * Decode `web_search_prime`'s doubly-encoded result. The MCP `content[0].text`
 * field holds a JSON-stringified array: `"[{\"title\":...,\"link\":..., ...}]"`.
 * Caller-friendly: returns `[]` on any parse failure rather than throwing.
 */
export function decodeWebSearchResult(contentBlocks: Array<{ type: string; text?: string }>): WebSearchHit[] {
  const text = contentBlocks.find((c) => c.type === "text")?.text;
  if (!text) return [];
  // First unwrap: text → JSON array string.
  let arrayStr: string;
  try {
    // The text field itself may be a quoted JSON string ("[...]" → [...])
    const unquoted = JSON.parse(text);
    arrayStr = typeof unquoted === "string" ? unquoted : text;
  } catch {
    arrayStr = text;
  }
  let arr: unknown;
  try {
    arr = JSON.parse(arrayStr);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((h): h is WebSearchHit => {
    if (typeof h !== "object" || h === null) return false;
    const hit = h as Record<string, unknown>;
    return typeof hit.title === "string" && typeof hit.link === "string";
  });
}

/** Concatenate all `text` blocks in an MCP result into a single string. */
function joinText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}
