/**
 * In-memory request log for the web dashboard.
 */
export interface RequestTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export interface RequestLogEntry {
  id: string;
  at: string;
  format: "anthropic" | "openai";
  model: string;
  stream: boolean;
  status: number;
  ttfbMs: number;
  /** Output tokens (legacy field name). */
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  tokPerSec: number;
  totalMs: number;
  accountId?: string;
  accountUserId?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Merge usage fields from an SSE JSON payload (Anthropic or Responses API). */
export function usageFromSsePayload(data: unknown): Partial<RequestTokenUsage> | null {
  if (!isRecord(data)) return null;

  if (data.type === "message_start" && isRecord(data.message) && isRecord(data.message.usage)) {
    const u = data.message.usage;
    return {
      inputTokens: num(u.input_tokens),
      cachedTokens: num(u.cache_read_input_tokens),
    };
  }

  if (data.type === "message_delta" && isRecord(data.usage)) {
    const u = data.usage;
    return {
      outputTokens: num(u.output_tokens),
      cachedTokens: num(u.cache_read_input_tokens),
    };
  }

  if (data.type === "response.completed" && isRecord(data.response) && isRecord(data.response.usage)) {
    const u = data.response.usage;
    const inDet = isRecord(u.input_tokens_details) ? u.input_tokens_details : {};
    const outDet = isRecord(u.output_tokens_details) ? u.output_tokens_details : {};
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cachedTokens: num(inDet.cached_tokens),
      reasoningTokens: num(outDet.reasoning_tokens) || num(u.reasoning_tokens),
    };
  }

  if (isRecord(data.usage)) {
    const u = data.usage;
    return {
      inputTokens: num(u.prompt_tokens) || num(u.input_tokens),
      outputTokens: num(u.completion_tokens) || num(u.output_tokens),
      cachedTokens: num(u.cache_read_input_tokens),
    };
  }

  return null;
}

/** Usage from a complete JSON response body (Anthropic message, OpenAI chat, Responses API). */
export function usageFromResponseBody(data: unknown): Partial<RequestTokenUsage> | null {
  if (!isRecord(data)) return null;

  if (data.type === "message" && isRecord(data.usage)) {
    const u = data.usage;
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cachedTokens: num(u.cache_read_input_tokens),
    };
  }

  if (isRecord(data.usage)) {
    const u = data.usage;
    const inDet = isRecord(u.input_tokens_details) ? u.input_tokens_details : {};
    const outDet = isRecord(u.output_tokens_details) ? u.output_tokens_details : {};
    return {
      inputTokens: num(u.prompt_tokens) || num(u.input_tokens),
      outputTokens: num(u.completion_tokens) || num(u.output_tokens),
      cachedTokens: num(u.cache_read_input_tokens) || num(inDet.cached_tokens),
      reasoningTokens: num(outDet.reasoning_tokens) || num(u.reasoning_tokens),
    };
  }

  return null;
}

export function mergeTokenUsage(
  base: RequestTokenUsage,
  patch: Partial<RequestTokenUsage> | null | undefined,
): RequestTokenUsage {
  if (!patch) return base;
  return {
    inputTokens: patch.inputTokens ?? base.inputTokens,
    outputTokens: patch.outputTokens ?? base.outputTokens,
    cachedTokens: patch.cachedTokens ?? base.cachedTokens,
    reasoningTokens: patch.reasoningTokens ?? base.reasoningTokens,
  };
}

export function normalizeTokenUsage(
  partial?: Partial<RequestTokenUsage> | null,
  legacyOutputTokens = 0,
): RequestTokenUsage {
  const output = partial?.outputTokens ?? legacyOutputTokens;
  return {
    inputTokens: partial?.inputTokens ?? 0,
    outputTokens: output,
    cachedTokens: partial?.cachedTokens ?? 0,
    reasoningTokens: partial?.reasoningTokens ?? 0,
  };
}

export class RequestLogStore {
  private entries: RequestLogEntry[] = [];
  private counter = 0;

  constructor(private maxEntries = 1000) {}

  append(
    partial: Omit<RequestLogEntry, "at" | "tokens" | "outputTokens"> & {
      at?: string;
      tokens?: number;
      outputTokens?: number;
      inputTokens?: number;
      cachedTokens?: number;
      reasoningTokens?: number;
    },
  ): RequestLogEntry {
    const usage = normalizeTokenUsage(
      {
        inputTokens: partial.inputTokens,
        outputTokens: partial.outputTokens ?? partial.tokens,
        cachedTokens: partial.cachedTokens,
        reasoningTokens: partial.reasoningTokens,
      },
      partial.tokens ?? 0,
    );
    const entry: RequestLogEntry = {
      id: partial.id,
      at: partial.at ?? new Date().toISOString(),
      format: partial.format,
      model: partial.model,
      stream: partial.stream,
      status: partial.status,
      ttfbMs: partial.ttfbMs,
      tokens: usage.outputTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      tokPerSec: partial.tokPerSec,
      totalMs: partial.totalMs,
      accountId: partial.accountId,
      accountUserId: partial.accountUserId,
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.length = this.maxEntries;
    }
    return entry;
  }

  list(opts: { limit?: number; offset?: number } = {}): {
    entries: RequestLogEntry[];
    total: number;
    summary: LogSummary;
  } {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    const slice = this.entries.slice(offset, offset + limit);
    return { entries: slice, total: this.entries.length, summary: this.summary() };
  }

  summary(): LogSummary {
    const now = Date.now();
    const dayAgo = now - 86_400_000;
    let last24h = 0;
    let ok = 0;
    let outputTokens = 0;
    let inputTokens = 0;
    let cachedTokens = 0;

    for (const e of this.entries) {
      const t = Date.parse(e.at);
      if (t >= dayAgo) {
        last24h += 1;
        if (e.status >= 200 && e.status < 300) ok += 1;
        outputTokens += e.outputTokens || e.tokens;
        inputTokens += e.inputTokens;
        cachedTokens += e.cachedTokens;
      }
    }

    return {
      total: this.entries.length,
      last24h,
      successRate: last24h > 0 ? Math.round((ok / last24h) * 100) : 100,
      totalTokens24h: outputTokens,
      totalInputTokens24h: inputTokens,
      totalOutputTokens24h: outputTokens,
      totalCachedTokens24h: cachedTokens,
      cacheHitRate24h: inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0,
    };
  }
}

export interface LogSummary {
  total: number;
  last24h: number;
  successRate: number;
  /** @deprecated use totalOutputTokens24h */
  totalTokens24h: number;
  totalInputTokens24h: number;
  totalOutputTokens24h: number;
  totalCachedTokens24h: number;
  cacheHitRate24h: number;
}
