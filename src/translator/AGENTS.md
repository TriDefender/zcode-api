# src/translator

Bidirectional OpenAI ↔ Anthropic translation: request bodies, response bodies, and SSE
streams. Only invoked in **translation mode** (OpenAI client → Anthropic upstream); Anthropic
requests pass through untouched. The hot path is `openai-to-anthropic.ts` +
`sse-translator.ts`, called from `proxy/handler.ts`.

## STRUCTURE
```
translator/
├── types.ts                  # Format, OpenAIChatRequest, AnthropicMessagesResponse, etc.
├── openai-to-anthropic.ts    # request OpenAI→Anthropic + response Anthropic→OpenAI (batch)
├── anthropic-to-openai.ts    # the reverse direction (request Anthropic→OpenAI + response)
├── sse-translator.ts         # SSE stream translation: anthropicSseToOpenaiSse / reverse
├── openai-to-anthropic.test.ts
└── sse-translator.test.ts
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Translate a new OpenAI request field | `openai-to-anthropic.ts:translateRequestOpenAIToAnthropic` | maps messages, tools, tool_choice, system, max_tokens |
| Translate a new response field | `openai-to-anthropic.ts:translateResponseAnthropicToOpenAI` | content blocks → choices, usage, stop_reason→finish_reason |
| Change SSE event mapping | `sse-translator.ts` | message_start/content_block_delta/message_stop → OpenAI chunks |
| Add/adjust a shared type | `types.ts` | `Format = "openai" \| "anthropic"` is imported across proxy too |
| Fix a streaming crash | `sse-translator.ts` | the `error()`/`close()` mutex — see ANTI-PATTERNS + root #1 |

## CONVENTIONS
- **Translation is lossless-by-intent but lossy-in-practice for deltas.** SSE chunk translation reconstructs OpenAI `choices[0].delta` from Anthropic `content_block_delta`; some Anthropic event types (e.g. `ping`, `message_delta` usage) map to `[DONE]`/usage only.
- **Consecutive `role:"tool"` messages coalesce into ONE Anthropic `user` turn** with multiple `tool_result` blocks (`openai-to-anthropic.ts`). Anthropic rejects adjacent tool messages — keep the coalescing.
- **Usage mapping:** Anthropic `input_tokens`/`output_tokens` → OpenAI `prompt_tokens`/`completion_tokens`; `stop_reason` → `finish_reason` (`end_turn`→`stop`, `tool_use`→`tool_calls`, …).
- **SSE translator runs on a `tee()`'d stream** — one branch goes to the client, the other to `handler.observeStream` for stats. Don't consume the input stream inside the translator.
- **`Format` is the routing key,** not just a label: `proxy/handler.ts` sets `upstreamFormat = translateMode ? "anthropic" : format`. Adding a format ripples through the whole pipeline.

## ANTI-PATTERNS
- **NEVER `controller.close()` after `controller.error()`** (`sse-translator.ts`). They're mutually exclusive on a `ReadableStreamController`; calling `close()` post-error throws `TypeError` and crashes Bun. Guard with an `errored` flag in every `pull`/`cancel`/`finally`. (This is root anti-pattern #1 — it lives here.)
- **Don't emit OpenAI chunks without a leading `role` delta.** OpenAI clients expect `choices[0].delta.role="assistant"` before content deltas; mirror `@ai-sdk/openai-compatible`.
- **Don't buffer the whole SSE stream** — translate incrementally inside `pull()`; the proxy streams to the client as bytes arrive.
