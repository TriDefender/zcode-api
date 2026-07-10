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
# Z.AI auth-code flow (chat.z.ai authorize → zcode.z.ai token exchange)
bun run src/index.ts auth login zai

# Bigmodel auth-code flow (bigmodel.cn authorize → zcode.z.ai token exchange)
bun run src/index.ts auth login bigmodel

# This will:
# 1. Print an authorize URL and open your browser
# 2. Exchange the auth code for upstream credentials
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
| `GET` | `/v1/models` | List available models |
| `GET` | `/webui` | Built-in chat web UI (served without the proxy key; see below) |
| `GET` | `/health` | Health check |

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
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.3.3` | `User-Agent: ZCode/{version}` |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |
| config file path | `ZCODE_PROXY_CONFIG` | `config.yaml` | Config file to load on `serve` |

Start-plan captcha tunables (env only): `ZCODE_CAPTCHA_RETRIES`, `ZCODE_CAPTCHA_TIMEOUT_MS`, `ZCODE_CAPTCHA_SDK_LOAD_MS`.

## Architecture

```
Client Request
      │
      ▼
Proxy API Key Auth (shared secret)
      │
      ▼
Route Detection + Plan-aware Routing
  /v1/chat/completions (OpenAI client format)
    ├─ coding-plan → TRANSLATE to Anthropic → provider's anthropic endpoint
    └─ start-plan  → zcode.z.ai OpenAI-compatible gateway (JWT + captcha)
  /v1/messages     (Anthropic client format)
    ├─ coding-plan → passthrough to provider's anthropic endpoint
    └─ start-plan  → TRANSLATE to OpenAI → zcode.z.ai gateway (JWT + captcha)
      │
      ▼
Body Transformation (ZCode-equivalent mutations)
  OpenAI streaming    → inject stream_options.include_usage
  start-plan          → prepend ZCode system messages
  Anthropic           → add cache_control to last user message
  Anthropic + OAuth   → inject metadata.user_id (coding-plan only)
      │
      ▼
[Translation mode] coding-plan OpenAI → Anthropic; start-plan Anthropic → OpenAI
      │
      ▼
Auth + Identity Header Injection
  Translation/coding-plan:  x-api-key: {credential} + anthropic-version
  Translation/start-plan:   Authorization: Bearer {jwt}
  Passthrough/start-plan:   Authorization: Bearer {jwt}
  Passthrough/coding-plan:  x-api-key: {credential} + anthropic-version
  Both:                     User-Agent: ZCode/{version} + X-ZCode-* + trace headers
      │
      ▼
Upstream Forward (Bun.fetch)
  Translation mode:   decompress enabled (proxy reads + translates body)
  Passthrough:        decompress disabled (raw gzip bytes stream through)
      │
      ▼
Response Handling
  Passthrough:              raw bytes → client (content-encoding preserved)
  Translation batch:        Anthropic JSON → OpenAI JSON → gzip if client accepts
  Translation SSE stream:   Anthropic SSE → OpenAI SSE chunks → client
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

Requests for models not in this list are still forwarded upstream — the listing is informational, not a gate.

## License

MIT
