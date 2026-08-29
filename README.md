# zcode-proxy

A reverse proxy for Z.AI / Bigmodel.cn coding-plan APIs that exposes both OpenAI-compatible and Anthropic-format endpoints.

## Quick Start

```bash
# Install dependencies
bun install

# Copy and edit config
cp config.example.yaml config.yaml
# Edit config.yaml — set your API key

# Start the proxy
bun run src/index.ts

# Or specify a config path
bun run src/index.ts /path/to/config.yaml
```

## Authentication

### Option 1: Direct API Key (simplest)

1. Get an API key from [Z.AI](https://z.ai) or [Bigmodel](https://bigmodel.cn)
2. For Z.AI you need `{apiKey}.{secretKey}` format
3. For Bigmodel you need `{apiKey}` format
4. Set it in `config.yaml`:

```yaml
auth:
  mode: apikey
  apiKey: "yourApiKey.yourSecretKey"
provider: zai  # or bigmodel
```

### Option 2: OAuth Login (browser-based, both providers)

```bash
# Z.AI server-mediated CLI login (3.10 parity: init/poll at zcode.z.ai, no local callback)
bun run src/index.ts auth login zai

# Bigmodel auth-code flow (bigmodel.cn authorize → localhost callback → zcode.z.ai token exchange)
bun run src/index.ts auth login bigmodel

# This will:
# 1. Print an authorize URL and open your browser
# 2. Z.AI: poll the server until authorization completes;
#    Bigmodel: receive the browser callback and exchange the auth code
# 3. Resolve your coding-plan API key automatically
# 4. Save encrypted credentials to ~/.zcode-proxy/credentials.json

# Then set config.yaml:
auth:
  mode: oauth
provider: zai  # or bigmodel
```

### Option 3: Import from ZCode Config (skip OAuth)

If you already use the ZCode desktop app, import the API key directly:

```bash
bun run src/index.ts auth login bigmodel --import
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming + non-streaming) |
| `POST` | `/v1/messages` | Anthropic-format messages (streaming + non-streaming) |
| `POST` | `/v1/responses` | OpenAI Responses API (Codex CLI / Agents SDK; translates to GLM Chat Completions) |
| `POST` | `/async/v1/messages` | **Async (off-peak)** Anthropic-format — routes to free idle-compute pool (oauth-only) |
| `POST` | `/async/v1/chat/completions` | **Async (off-peak)** OpenAI-format — same backend, translates request/response |
| `GET`  | `/async/v1/health` | Probe off-peak queue availability (oauth-only) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/webui` | Built-in chat web UI (served without the proxy key; see below) |
| `GET` | `/health` | Health check |

### Async (Off-Peak / Idle Plan)

`/async/*` routes are gated by `async.enabled: true` in config (default `false`).
They require `auth.mode: oauth` (the off-peak backend needs both the JWT from
login and the coding-plan API key — apikey-only mode returns 400
`async_credentials_unavailable`).

When enabled, requests are routed through ZCode's off-peak ticket-queue backend:
the proxy takes a ticket, holds the connection open with SSE keepalive comments
while waiting for a free slot, then streams the upstream response through. If
the ticket expires mid-run (server reclaims the slot), the proxy automatically
takes a new ticket and resends the original request (up to `async.maxRetries`,
default 3). Client disconnect triggers a fire-and-forget `/ticket/{id}/settle`
call as the universal close-out signal.

Streaming (`stream: true`) is the expected mode for coding harnesss; non-stream
is supported as a fallback (the proxy internally still consumes upstream as a
stream, then emits one aggregated JSON body).

**Off-peak is one-shot, not conversational.** Each `/async/*` request is an
independent task with its own ticket; the proxy does NOT preserve conversation
history across requests. To do multi-turn, send the full conversation in each
request (typical for stateless chat completions clients), or use the synchronous
`/v1/*` endpoints which can leverage server-side session affinity.

**Phase 1 limitations** (planned for Phase 2):
- No native async task API (`POST /async/v1/tasks` with persistent store) — bridge mode only
- No concurrency cap on `/async/*` routes — body size is capped at 4 MiB but unlimited simultaneous connections are allowed
- No persistent state across proxy restarts

```bash
curl http://localhost:8080/async/v1/messages \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Weekend-Plan Auto-Claim (manualClaimPlan)

ZCode 3.10 exposes limited-quota trial plans (e.g. weekend packages) that are
claimed first-come-first-served and activate at a future time. The proxy can
grab them for you automatically — it polls the preview endpoint every 5 minutes
and claims the highest-priority plan the moment the campaign endpoint goes live
(a 404 before launch is the expected pre-campaign state). Requires
`auth.mode: oauth` and `identity.appVersion >= 3.10.0`.

```yaml
claim:
  enabled: true   # start the auto-claim scheduler while serving
  # auto: true    # set false to only use the CLI command
  # planId: ""    # claim a specific plan; empty = highest priority
```

One-shot usage:

```bash
zcode-proxy claim list   # show currently claimable plans
zcode-proxy claim        # claim now (highest priority, or claim.planId)
```

Backoff: `already_claimed`/`quota_exhausted` wait for the server-provided next
window; other failures use `claim.cooldownMs` (default 10 min).

## Usage Examples

### OpenAI Format

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Anthropic Format

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-4.6",
    "messages": [{"role": "user", "content": "Write a poem"}],
    "stream": true
  }'
```

### List Models

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-proxy-secret"
```

### Web UI

Open `http://localhost:8080/webui` in a browser for a built-in, ChatGPT-style
chat client. The page is served **without** the proxy API key (so it can load
and present the key input); it then sends the key on its own `/v1/*` calls.

Features: streaming responses (SSE), model picker (auto-populated from
`/v1/models`), editable system prompt, temperature / top-p / max-tokens /
`do_sample`, deep-thinking toggle with `reasoning_effort` (GLM-5.2+), image
upload (auto-enabled for models whose id contains `v`), MCP HTTP servers,
markdown + code-highlight rendering, light/dark theme, and per-browser
multi-session autosave (localStorage). Open Settings (⚙) to configure.

## Configuration

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `server.port` | `ZCODE_PROXY_PORT` | `8080` | Listen port |
| `auth.apiKey` | `ZCODE_API_KEY` | — | Upstream API key |
| `auth.proxyApiKey` | `ZCODE_PROXY_API_KEY` | — | Client auth key |
| `provider` | `ZCODE_PROVIDER` | `zai` | Upstream provider |
| `plan` | — | `coding-plan` | Plan tier: `coding-plan` (direct upstream) or `start-plan` (zcode.z.ai gateway + JWT + captcha) |
| `providers.<p>.credential` | — | — | Per-provider credential override (else uses `auth.apiKey`) |
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.10.0` | `User-Agent: ZCode/{version}` |
| `identity.deviceMid` | `ZCODE_IDENTITY_DEVICE_MID` | auto-generated | Device identity (`X-Device-Mid`); UUIDv4 generated once at first `auth login` / config creation and reused forever |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |
| `endpointRouting.enabled` | `ZCODE_ENDPOINT_ROUTING` | `true` | Server-controlled upstream URL remapping via `zcode.z.ai/api/v1/agent/configs` (mirrors ZCode's `ProviderEndpointRoutingService`; fail-open) |
| `clientSigning.enabled` | `ZCODE_CLIENT_SIGNING` | `true` | Client request signing V4 (Ed25519 + proof-of-work, gate-driven; only activates when the server sets `codingPlanSignature.enable=true`; fail-open) |
| `claim.enabled` | `ZCODE_CLAIM_ENABLED` | `false` | Weekend-plan auto-claim: poll `zcode.z.ai/api/v1/zcode-plan/billing/preview` and claim trial packages (oauth-only; see below) |
| config file path | `ZCODE_PROXY_CONFIG` | `config.yaml` | Config file to load on `serve` |

Start-plan captcha tunables (env only): `ZCODE_CAPTCHA_RETRIES` (per-token solve retries), `CAPTCHA_POOL_MIN` / `CAPTCHA_POOL_MAX` (pre-solved token pool sizing).

## Architecture

```
Client Request
      │
      ▼
Proxy API Key Auth (shared secret)
      │
      ▼
Route Detection + Plan-aware Routing (both plans post Anthropic upstream, v2.4+)
  /v1/chat/completions (OpenAI client format)
    ├─ coding-plan → TRANSLATE OpenAI→Anthropic → provider's anthropic endpoint
    │                (remapped to zcode.z.ai ultra endpoints via server-controlled mapping)
    └─ start-plan  → TRANSLATE OpenAI→Anthropic → zcode.z.ai
                     /api/v1/zcode-plan/anthropic/v1/messages (JWT + captcha)
  /v1/messages     (Anthropic client format)
    ├─ coding-plan → NATIVE PASSTHROUGH to the provider's anthropic endpoint (same format)
    └─ start-plan  → NATIVE PASSTHROUGH → zcode.z.ai
                     /api/v1/zcode-plan/anthropic/v1/messages (JWT + captcha)
  /v1/responses    (Responses client format)
    ├─ both plans  → TRANSLATE Responses→Chat→Anthropic → plan's anthropic endpoint
      │
      ▼
Body Transformation (ZCode-equivalent mutations)
  Anthropic upstream      → cache_control on last message + metadata.user_id (oauth)
  start-plan              → prepend ZCode system messages
      │
      ▼
Auth + Identity Header Injection
  Anthropic upstream:      x-api-key: {credential} + anthropic-version
  OpenAI upstream:         Authorization: Bearer {credential}
  Both:                    User-Agent: ZCode/{version} + X-ZCode-* + trace headers
      │
      ▼
Endpoint Routing (server-controlled, fail-open)
  GET zcode.z.ai/api/v1/agent/configs → proxyEndpoint.mapping rewrites the upstream URL
      │
      ▼
Client Signing V4 (gate-driven, fail-open)
  gate says codingPlanSignature.enable → handshake + Ed25519 + PoW headers per request
      │
      ▼
Upstream Forward (Bun.fetch)
  Translation mode:   decompress enabled (proxy reads + translates body)
  Passthrough:        decompress disabled (raw gzip bytes stream through)
      │
      ▼
Response Handling
  Passthrough:              raw bytes → client (content-encoding preserved)
  Translation batch:        Anthropic JSON ↔ OpenAI JSON (gzip if client accepts)
  Translation SSE stream:   translated chunk-for-chunk in the client's format
```
## Development

```bash
# Run tests
bun test

# Type check
bun x tsc --noEmit

# Run in dev mode
bun run src/index.ts config.yaml

# Compile a single-file binary (→ zcode-proxy.exe, gitignored)
bun run build
```

## Docker

Pull the multi-arch image from GitHub Packages (ghcr.io):

```bash
docker pull ghcr.io/tridefender/zcode-proxy:latest
```

Run with env-var configuration (no config file needed):

```bash
docker run --rm -p 8080:8080 \
  -e ZCODE_API_KEY="yourApiKey.yourSecretKey" \
  -e ZCODE_PROVIDER=zai \
  -e ZCODE_PROXY_API_KEY="your-proxy-secret" \
  ghcr.io/tridefender/zcode-proxy:latest
```

Or mount a config file:

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)/config.yaml:/data/config.yaml:ro" \
  ghcr.io/tridefender/zcode-proxy:latest
```

> Note: `/health` and all routes sit behind the proxy-API-key check, so health probes must send `x-api-key: <ZCODE_PROXY_API_KEY>`.

Common environment variables (see the Configuration table above for the full list):

| Env Var | Description |
|---------|-------------|
| `ZCODE_API_KEY` | Upstream API key (`{apiKey}.{secretKey}` for Z.AI, `{apiKey}` for Bigmodel) |
| `ZCODE_PROVIDER` | `zai` or `bigmodel` |
| `ZCODE_PROXY_API_KEY` | Client auth shared secret |
| `ZCODE_PROXY_PORT` | Listen port (default `8080`) |

docker-compose:

```yaml
services:
  zcode-proxy:
    image: ghcr.io/tridefender/zcode-proxy:latest
    ports:
      - "8080:8080"
    environment:
      ZCODE_API_KEY: "yourApiKey.yourSecretKey"
      ZCODE_PROVIDER: zai
      ZCODE_PROXY_API_KEY: "your-proxy-secret"
    restart: unless-stopped
```

## Available Models

The proxy lists these models on `GET /v1/models` (pinned to the GLM coding-plan tier):

| Model | Context | Max Output |
|-------|---------|------------|
| `glm-4.5-air` | 200K | 128K |
| `glm-4.6` | 200K | 128K |
| `glm-4.6v` | 200K | 128K |
| `glm-4.7` | 200K | 128K |
| `glm-5` | 200K | 128K |
| `glm-5-turbo` | 200K | 128K |
| `glm-5v-turbo` | 200K | 128K |
| `glm-5.1` | 200K | 128K |
| `glm-5.2` | 1M | 128K |
| `glm-5.3` | 1M | 128K |

Requests for models not in this list are still forwarded upstream — the listing is informational, not a gate.

## License

MIT
