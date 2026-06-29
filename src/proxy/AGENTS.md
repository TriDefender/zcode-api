# src/proxy

The hot core: the full request pipeline between the server routes and the upstream.
Everything auth-injection, identity-spoofing, body-mutation, captcha, and response
streaming/translation lives here. See root `AGENTS.md` for the project-level anti-patterns
(jsdom import, captcha CDN, `decompress` rules, no upstream timeout) — they all originate here.

## STRUCTURE
```
proxy/
├── handler.ts          # proxyRequest(): the pipeline. Largest file (~520 LOC).
├── upstream.ts         # buildUpstreamRequest(): URL + auth + identity header assembly
├── body-transformer.ts # transformRequestBody(): ZCode-equivalent body mutations
├── identity.ts         # buildIdentityHeaders(): the 5 fingerprint headers
├── captcha.ts          # Aliyun CAPTCHA V3 solver (start-plan only, jsdom-based)
├── system-prompt.ts    # buildStartPlanSystem(): gateway identity blocks (loads zcode_system.json)
├── zcode_system.json   # static ZCode system-prompt payload, prepended on start-plan
└── AliyunCaptcha.js.txt# vendored SDK source, loaded as text (NOT from CDN)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Change request flow / add a branch | `handler.ts:proxyRequest` | reads body → auth → translate → transform → build → fetch → {stream\|batch} |
| Change which headers go upstream | `upstream.ts` | `STRIP_HEADERS` set + per-plan auth header pick |
| Add a body mutation | `body-transformer.ts` | keyed by `{format, startPlan}`; see existing 4 mutations |
| Change the desktop fingerprint | `identity.ts` | exactly 5 headers — adding one likely breaks upstream acceptance |
| Fix captcha solve failures | `captcha.ts` | singleton solver; `getCaptchaToken`/`invalidateCaptchaToken`/`detectCaptchaChallenge` |
| Tune the request log table | `handler.ts:printRow/printHeader/observeStream` | the `#NNN \| Time \| Fmt \| Model \| Stat \| TTFB \| Tok \| tok/s \| Total` table |

## PIPELINE DETAIL (proxyRequest)
```
readBody → peekBody(model,stream) → auth.getCredential()
  [openai] translateOpenAIBody → anthropic body
  transformRequestBody(upstreamFormat, userId, startPlan)
  [start-plan] getCaptchaToken → captcha headers
  buildUpstreamRequest(...)
  fetch(upstream, translateMode ? {} : { decompress:false })
    [start-plan 401] → 401 start_plan_jwt_invalid (re-login needed)
    [start-plan 403/captcha] → invalidate + re-solve + retry ONCE
  [translate+SSE] anthropicSseToOpenaiSse (tee'd: one stream to client, one to observeStream stats)
  [translate+batch] translatedBatchResponse (re-gzip if client accepts)
  [passthrough] passthroughResponse (preserve content-encoding, forward ratelimit headers)
```
`reqId` is a module-global counter (`#001`, `#002`…); `printHeader` prints the table once.

## CONVENTIONS
- **Two response modes share one fetch:** passthrough streams raw bytes (`decompress:false`), translation lets Bun inflate so the body can be rewritten. Never mix the option across the two branches.
- **Captcha is lazy + cached:** `getCaptchaToken` solves once and caches; a 403 challenge invalidates and re-solves exactly once (`handler.ts:143-166`). Don't make it eager — solving costs a browser-less DOM round-trip.
- **Identity blocks are prepended, not merged:** `body-transformer` prepends `buildStartPlanSystem()` for start-plan; the gateway content-inspects them or returns 3012. Keep them first.
- **Forwarded response headers are an explicit allowlist** (`handler.ts:209-220`, `:316-326`): `content-type`, `content-encoding`, `cache-control`, `x-request-id`, and the `anthropic-ratelimit-*` family. Add new upstream headers here, not ad hoc.
- **`reqId` / debug lines are stdlib-only:** `proxyRequest` is pure aside from the module-global request counter and `console.log`. Tests inject `fetchImpl` and capture `console.log` — keep it that way.

## ANTI-PATTERNS
- **Don't retry the same failing captcha token verbatim** — invalidate then re-solve (`handler.ts:147`). A 403 means the token was rejected upstream.
- **Don't read `upstreamResp.body` twice** — translation mode either `.text()`s it (batch) or hands the stream to `anthropicSseToOpenaiSse`; passthrough tees it. A second read is empty.
- **Don't add an upstream `AbortController`/timeout** — see root anti-pattern #7. Connection errors only.
