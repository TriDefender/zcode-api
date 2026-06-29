# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-24
**Commit:** b43eb16
**Branch:** master

## OVERVIEW
`zcode-proxy` (v2.0.2) — a Bun + TypeScript reverse proxy that exposes Z.AI / Bigmodel.cn
coding-plan APIs through both OpenAI-compatible (`/v1/chat/completions`) and Anthropic-format
(`/v1/messages`) endpoints, translating between the two and injecting the ZCode desktop-client
fingerprint so requests are accepted upstream.

## STRUCTURE
```
zcodeplus/
├── src/                 # ALL app code (ESM, run directly by Bun — no build step for dev)
│   ├── index.ts         # CLI entry: serve | auth login/logout/status | version | help
│   ├── integration.test.ts  # full e2e (mock upstream via in-process Bun.serve)
│   ├── auth/            # OAuth (device/auth-code), AES-GCM credential store, key resolution
│   ├── config/          # YAML loader (env>YAML>defaults), types, bundled template
│   ├── provider/        # Provider registry (zai|bigmodel) + pinned GLM model list
│   ├── proxy/           # HOT CORE: request pipeline, identity headers, captcha, body mutation
│   ├── server/          # Bun.serve bootstrap, CORS, proxy-key auth, route handlers
│   └── translator/      # OpenAI<->Anthropic body + SSE translation (bidirectional)
├── _reverse/            # [GITIGNORED, READ-ONLY] reverse-engineered ZCode bundle — the spec source
├── config.example.yaml  # annotated template — EMBEDDED into the compiled binary (template.ts)
├── config.test.yaml     # test fixture (port 19090, fake keys, mock upstream)
├── config.yaml          # [GITIGNORED] live config with real secrets
├── PROMPT.md            # extracted ZCode system-prompt structure (reference, not app logic)
└── zcode-proxy*         # [GITIGNORED] compiled single-file binaries
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a request-transform rule | `src/proxy/body-transformer.ts` | stream_options, cache_control, user_id, start-plan system blocks |
| Change injected identity headers | `src/proxy/identity.ts` | 5 headers mirror ZCode desktop; do not add/omit |
| Add an upstream header / auth scheme | `src/proxy/upstream.ts` | `STRIP_HEADERS` set + `anthropic-version` const |
| Add a CLI command / flag | `src/index.ts` | `main()` dispatches on `args[0]` |
| Add a model | `src/provider/models.ts` + `config.example.yaml` `models:` | listing is informational, not a gate |
| Add a provider | `src/provider/providers.ts` + `ProxyConfig.providers` type | only `zai`\|`bigmodel` validated at load |
| Change config cascade / validation | `src/config/loader.ts` | env var → YAML → default; throws on invalid provider |
| Add an HTTP route | `src/server/{server,routes-*}.ts` | OpenAI routes vs Anthropic routes split by format |
| Debug a proxied request | run `zcode-proxy serve debug` | prints URL, redacted headers, body preview, TTFB/tok/s table |
| Understand upstream protocol | `_reverse/NOTEPAD.md` + `_reverse/zcode.cjs` | READ-ONLY; the canonical reference |

## CODE MAP
Grounded in codegraph (LSP unavailable). Refs = inbound import count across `src/`.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|:----:|------|
| `proxyRequest` | fn | `src/proxy/handler.ts:52` | 3 | **HOT CORE** — full request pipeline (auth→translate→forward→stream) |
| `errorResponse` | fn | `src/proxy/handler.ts:235` | 3 | JSON error body builder |
| `loadConfig` | fn | `src/config/loader.ts` | 4 | YAML+env loader, validation, identity defaults |
| `startServer` | fn | `src/server/server.ts` | 3 | Bun.serve bootstrap + routing |
| `AuthManager` | class | `src/auth/manager.ts` | 5 | per-request credential resolution (apikey\|oauth) |
| `buildUpstreamRequest` | fn | `src/proxy/upstream.ts` | 2 | URL + auth + identity header assembly |
| `transformRequestBody` | fn | `src/proxy/body-transformer.ts` | 2 | ZCode-equivalent body mutations |
| `buildIdentityHeaders` | fn | `src/proxy/identity.ts` | 2 | the 5 fingerprint headers |
| `getProvider` | fn | `src/provider/providers.ts` | 2 | provider def lookup |
| `ProxyConfig` | type | `src/config/types.ts:48` | 7 | top-level config shape |
| `Credential` | type | `src/auth/types.ts` | 7 | credential record + `credentialString()` |
| `ProviderId` | type | `src/provider/types.ts` | 11 | `"zai"`\|`"bigmodel"` — used everywhere |
| `ProxyIdentity` | type | `src/config/types.ts:41` | 4 | identity header source values |
| `Format` | type | `src/translator/types.ts` | 5 | `"openai"`\|`"anthropic"` |

Request hot path: `server.ts → routes-{openai,anthropic}.ts → proxyRequest() → auth.getCredential() + transformRequestBody() + buildUpstreamRequest() → fetch → {translate\|passthrough}`.

## CONVENTIONS
- **Bun-only.** Runtime, package manager, test runner, and compiler are all Bun. No Node, no npm/yarn/pnpm. `bun run src/index.ts` executes TS directly.
- **ESM with `.js` import specifiers.** `"type": "module"`; every import ends in `.js` even for `.ts` source (e.g. `from "./loader.js"`).
- **`tsconfig` is type-check only** (`noEmit: true`, `strict`, `moduleResolution: "bundler"`, `types: ["bun-types"]`). Verify types with `bun x tsc --noEmit`.
- **Tests:** `bun:test`, co-located as `*.test.ts` next to the SUT. Mock fetch via `fetchImpl` injection or `bun:test` `mock()`. 215 tests, all green. Integration tests spin up a real `Bun.serve` mock upstream on a random port.
- **No linter / formatter / CI.** Match surrounding style by hand (see `PROMPT.md`).
- **Config cascade:** env var → YAML → hardcoded default. See `config.example.yaml` for the full annotated schema.
- **File naming:** kebab-case files; PascalCase exported classes/interfaces; no barrel `index.ts` files — import named modules directly.

## ANTI-PATTERNS (THIS PROJECT)
1. **NEVER call `close()` after `error()` on a ReadableStreamController** — `src/translator/sse-translator.ts`. They're mutually exclusive; `close()` post-error throws `TypeError` that crashes the Bun engine. Guard with an `errored` flag.
2. **NEVER dynamically `import("jsdom")`** — `src/proxy/captcha.ts:12`. Under `bun build --compile` it yields `{default:{}}` with no named exports. Use static `import { JSDOM, VirtualConsole }`.
3. **NEVER load the AliyunCaptcha SDK from CDN at runtime** — `src/proxy/captcha.ts:4`. CDN is the #1 solve-failure source; a local path breaks under `--compile`. Bundle as `import ... with { type: "text" }`.
4. **NEVER swallow AliyunCaptcha errors in `getInstance`** — if `reject()` isn't called in every callback (`getInstance`/`fail`/`onError`), `success` never fires and the solver hangs to the outer timeout.
5. **NEVER commit `config.yaml`** (real secrets) or modify **`_reverse/`** (read-only reverse-engineered artifacts). Only `config.example.yaml` is tracked.
6. **Passthrough (Anthropic) mode MUST use `decompress: false`**; translation (OpenAI) mode MUST NOT (it needs to read+translate the body). See `src/proxy/handler.ts:41-50`.
7. **Do NOT add an upstream timeout** on LLM calls — intentionally matches ZCode desktop; only connection errors surface as 502.
8. **`appVersion` must be printable ASCII** (`/^[\x20-\x7e]+$/`) — non-conforming values are silently dropped, falling back to `"3.1.1"` (mirrors the bundle's `rYn`). Intentional.
9. **Start-plan gateway REQUIRES ZCode identity system blocks** — without them `zcode.z.ai` returns 3012. They're auto-prepended by `transformRequestBody` when `startPlan=true`.
10. **CORS `access-control-allow-origin: *` is intentional** (self-use proxy) — don't restrict it.
11. **Legacy Z.AI device/poll OAuth flow is dead** (`/oauth/cli/init`+`poll` → 404). Only the auth-code flow works (`src/auth/oauth.ts`).

## UNIQUE STYLES
- **Single-binary cross-compile:** `bun build --compile` (with `--define "require.resolve=undefined"`) emits self-contained `zcode-proxy.exe` / `-linux-x64` / `-linux-arm64` from one `src/index.ts`.
- **Identity mimicry as a feature:** the whole point is to impersonate the ZCode desktop client (User-Agent, X-ZCode-*, HTTP-Referer) so upstream accepts the request. See `_reverse/NOTEPAD.md` "How Credential is Used".
- **`config.example.yaml` is the source of truth** for both the runtime default AND the embedded template (`src/config/template.ts` imports it as text). Changing config schema means editing both.
- **Two plan tiers** drive most branching: `coding-plan` (direct upstream, API key) vs `start-plan` (zcode.z.ai gateway, JWT + captcha). Almost every module has `if (startPlan)` paths.

## COMMANDS
```bash
bun install                       # deps
bun run dev                       # = bun run src/index.ts (defaults to serve + config.yaml)
bun run src/index.ts serve debug [config.yaml]   # verbose per-request diagnostics
bun run src/index.ts auth login bigmodel         # OAuth login (or: zai)
bun run src/index.ts auth login bigmodel --import # import key from ~/.zcode/v2/config.json
bun test                          # all tests (215)
bun x tsc --noEmit                # type-check only
bun run build                     # → zcode-proxy.exe (Windows)
bun run build:linux-x64           # cross-compile Linux x64
bun run build:linux-arm64         # cross-compile Linux arm64
```
Key env: `ZCODE_PROXY_PORT` (8080), `ZCODE_API_KEY`, `ZCODE_PROXY_API_KEY`, `ZCODE_PROVIDER` (zai), `ZCODE_PROXY_CONFIG` (config.yaml). Start-plan captcha tunables: `ZCODE_CAPTCHA_RETRIES`, `ZCODE_CAPTCHA_TIMEOUT_MS`, `ZCODE_CAPTCHA_SDK_LOAD_MS`.

## NOTES
- **Version mismatch:** `package.json` says `2.0.2` but `src/index.ts` hardcodes `VERSION = "2.0.1"`. Keep in sync when bumping.
- **`_reverse/` is the spec.** `zcode.cjs` (9.4MB, deobfuscated) is the canonical reference for upstream behavior; `NOTEPAD.md` distills auth flows + endpoints; `models_catalog.json` is the authoritative model list. `tsconfig` and `.gitignore` both exclude it.
- **Test coverage gaps (no dedicated tests):** `src/proxy/captcha.ts`, `src/proxy/system-prompt.ts`, `src/config/template.ts`, `src/server/routes-{openai,anthropic}.ts`. `proxy/handler.ts` has no dedicated test (exercised via `upstream.test.ts`, `handler-debug.test.ts`, `integration.test.ts`).
- **`config.yaml` auto-creates** from the bundled template on first `serve` if missing.
- **OAuth credentials** are AES-256-GCM encrypted at `~/.zcode-proxy/credentials.json`.
- **Subdirectory knowledge bases:** `src/proxy/AGENTS.md`, `src/auth/AGENTS.md`, `src/translator/AGENTS.md` (provider/server/config are covered above).
```
