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

# Open the web dashboard
# http://localhost:8080/app

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
# Z.AI device/poll flow
bun run src/index.ts auth login zai

# Bigmodel auth-code flow (via zcode.z.ai proxy)
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

### Option 4: ZCode Start Plan (free tier, JWT + captcha)

Start Plan uses `zcode.z.ai` with OAuth JWT and Aliyun traceless captcha — not the paid `api.z.ai` key.

**Web dashboard (recommended):**

```bash
bun run src/index.ts
# open http://localhost:8080/app
```

Click **Add account (OAuth)** — sign in, quota provisioning, and pool setup happen automatically.

**CLI alternatives:**

```bash
bun run src/index.ts auth onboard zai          # new account
bun run src/index.ts auth import-jwt             # existing ZCode desktop login
```

**Then configure and start:**

```yaml
auth:
  mode: oauth
  proxyApiKey: "your-proxy-secret"
plan: start-plan
provider: zai

identity:
  appVersion: "3.1.2"
```

```bash
bun run src/index.ts
```

Requires Node.js for captcha solver (`captcha_node/` — installed automatically on first use).

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: your-proxy-secret" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","max_tokens":32,"messages":[{"role":"user","content":"say ok"}]}'
```

Re-run `auth import-jwt` or `auth onboard zai` after switching accounts. **Test one message at a time** — burst captcha requests can trigger abuse block (3012).

### Multi-account pool (one app, load balancing)

**Use the web dashboard** at `http://localhost:8080/app` — add accounts via OAuth, import from desktop, paste JWTs, pause/remove accounts, and send test messages. No CLI required.

Add multiple Start Plan accounts; the proxy round-robins and auto-fails over on quota (`1005`), abuse block (`3012`), or bad JWT (`401`).

```bash
# Add accounts (each runs OAuth + optional ZCode provisioning)
bun run src/index.ts auth onboard zai --name acct-1
bun run src/index.ts auth onboard zai --name acct-2

# Or add an existing JWT
bun run src/index.ts auth add acct-3 --jwt eyJ...

# List / remove
bun run src/index.ts auth accounts
bun run src/index.ts auth remove <account-id>
```

Enable in `config.yaml` (default when accounts exist):

```yaml
pool:
  enabled: true
  maxAccountAttempts: 5   # try up to N accounts per request
```

HTTP admin (requires `auth.proxyApiKey`):

```bash
curl http://localhost:8080/admin/accounts -H "x-api-key: your-proxy-secret"
curl -X POST http://localhost:8080/admin/accounts/<id>/enable -H "x-api-key: your-proxy-secret"
curl -X DELETE http://localhost:8080/admin/accounts/<id> -H "x-api-key: your-proxy-secret"
```

`GET /health` includes pool summary (account count, enabled, last errors).

Fixes #2.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (streaming + non-streaming) |
| `POST` | `/v1/messages` | Anthropic-format messages (streaming + non-streaming) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/app` | Web dashboard (account management UI) |
| `GET` | `/health` | Health check (+ pool summary when enabled) |
| `GET` | `/admin/accounts` | List account pool (proxy API key required) |
| `POST` | `/admin/accounts/:id/enable` | Re-enable a disabled account |
| `DELETE` | `/admin/accounts/:id` | Remove account from pool |

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

## Configuration

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `server.port` | `ZCODE_PROXY_PORT` | `8080` | Listen port |
| `auth.apiKey` | `ZCODE_API_KEY` | — | Upstream API key |
| `auth.proxyApiKey` | `ZCODE_PROXY_API_KEY` | — | Client auth key |
| `provider` | `ZCODE_PROVIDER` | `zai` | Upstream provider |
| `identity.appVersion` | `ZCODE_APP_VERSION` | `3.1.2` | `User-Agent: ZCode/{version}` |
| `plan` | — | `coding-plan` | `start-plan` for ZCode free tier (JWT + captcha) |
| `identity.sourceTitle` | `ZCODE_SOURCE_TITLE` | `cli` | `X-Title: Z Code@{title}` |
| `identity.refererOrigin` | `ZCODE_REFERER_ORIGIN` | `https://zcode.z.ai` | `HTTP-Referer` URL |

## Architecture

```
Client Request
      │
      ▼
Proxy API Key Auth (shared secret)
      │
      ▼
Route Detection
  /v1/chat/completions → OpenAI upstream
  /v1/messages        → Anthropic upstream
      │
      ▼
Body Transformation (ZCode-equivalent mutations)
  OpenAI streaming    → inject stream_options.include_usage
  Anthropic           → add cache_control to last user message
  Anthropic + OAuth   → inject metadata.user_id
      │
      ▼
Auth + Identity Header Injection
  OpenAI:    Authorization: Bearer {credential}
  Anthropic: x-api-key: {credential} + anthropic-version
  Both:      User-Agent: ZCode/{version} + X-ZCode-* + trace headers
      │
      ▼
Upstream Forward (Bun.fetch) → Stream response back
```

## Development

```bash
# Run tests
bun test

# Type check
bun x tsc --noEmit

# Run in dev mode
bun run src/index.ts config.yaml
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
