/**
 * Bundled config template — inlined as a string constant so it compiles into
 * the single-file binary (`bun build --compile`) without requiring a sidecar
 * `config.example.yaml` file at runtime.
 *
 * Source of truth: config.example.yaml at repo root. When editing the schema,
 * update BOTH this file AND config.example.yaml to keep them in sync.
 */

export const EXAMPLE_CONFIG_YAML: string = `server:
  port: 8080
  host: "0.0.0.0"

auth:
  # Key that clients must provide to use the proxy.
  # Set to null/omit to disable client auth.
  proxyApiKey: "your-proxy-secret"

  # Upstream credentials come from the OAuth login flow — run this first:
  #   bun run src/index.ts auth login <zai|bigmodel>
  # Parsed but currently not honored — the credential store path is fixed at
  # ~/.zcode-proxy/credentials.json:
  # oauthCredentialsPath: "~/.zcode-proxy/credentials.json"

# Which upstream provider to use: "zai" or "bigmodel"
provider: zai

# Which plan tier to use:
#   "coding-plan" (default) — direct upstream endpoints, permanent API key
#   "start-plan"            — routes through zcode.z.ai with JWT auth (requires \`auth login\`)
plan: coding-plan

# Start-plan captcha controls (environment variables only, milliseconds):
# CAPTCHA_ACQUIRE_BUDGET_MS=45000 bounds initial acquisition and retry backoff.
# Expiry returns 503 without forwarding; client abort stops waiting immediately.
# CAPTCHA_CONFIG_TIMEOUT_MS=15000 covers config headers AND the complete body.
# CAPTCHA_CONFIG_TTL_MS=3600000 caches successful snapshots only. Refresh errors
# preserve the last known config, including an explicit disabled state.
# Non-numeric, non-finite, or non-positive values use the defaults above.

providers:
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"

# Default model used when a client request omits \`model\`.
defaultModel: glm-5.3

# Informational model list surfaced in the TUI / startup output; any other
# model id still forwards upstream (no whitelist enforcement).
models:
  - glm-5.3
  - glm-5.3-flash

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-Title, X-ZCode-Agent, HTTP-Referer).
# X-ZCode-App-Version is not configurable: the app version is pinned in code
# (DEFAULT_APP_VERSION in src/config/loader.ts) and auto-bumps with mirror
# snapshot updates. Runtime platform headers (X-Platform, X-Os-Category,
# X-Os-Version) are detected dynamically and are not configured here. All
# fields below are optional; env vars override YAML, which overrides defaults.
identity:
  # X-Title suffix → "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"
  # Device identity (X-Device-Mid) — random UUIDv4, generated ONCE and reused
  # forever (mirrors ZCode's telemetry deviceMid; no hardware values involved).
  # Auto-generated into this file at first \`auth login\` or config creation.
  # Leave empty on Android — the app injects ZCODE_IDENTITY_DEVICE_MID instead.
  deviceMid: ""

# Local client-session inference for upstream session affinity.
# "enforce" (default) forwards a stable x-session-id for inferred sessions
# (cache affinity + closer to the official client, whose signing template
# always carries a session id). "observe" logs inferred sessions in debug
# mode without changing upstream x-session-id. "off" disables inference.
clientIdentity:
  mode: enforce
  ttlSeconds: 900
  maxSessions: 1024

# Server-controlled upstream URL remapping (mirrors the ZCode client's
# ProviderEndpointRoutingService). The proxy periodically fetches
# {origin}/api/v1/agent/configs and rewrites matching upstream URLs per the
# returned proxyEndpoint.mapping table (currently the coding-plan Anthropic
# endpoints -> zcode.z.ai ultra endpoints). Fail-open: any fetch/parse error
# keeps the original URLs. Env override: ZCODE_ENDPOINT_ROUTING=false.
endpointRouting:
  enabled: true
  origin: "https://zcode.z.ai"

# Client request signing V4 (mirrors the ZCode 3.15.1 static signing rule).
# When enabled, coding-plan requests are always signed: handshake against
# {provider}/api/paas/c1f3a7e2/v2/client, Ed25519 signature + proof-of-work
# headers on every request, fail-open retry ladder (two 401 VERIFY rejections
# -> permanent unsigned bypass). Start-plan and off-peak paths are never
# signed (the old agent/configs codingPlanSignature gate is gone on both
# sides). Env override: ZCODE_CLIENT_SIGNING=false.
clientSigning:
  enabled: true

# HighSpeed 加速卡 (mirrors the ZCode 3.15.1 HighspeedCardService — Coding Plan
# subscriber benefit, server-side random draw). Enabled by default, matching the
# official client (which has no toggle): the first eligible coding-plan request
# ignites a background draw loop (POST {origin}/api/v1/highspeed/draw at ~1/s —
# the measured token-bucket refill rate; server next_draw_at is ignored on a
# miss); on a hit, requests inside the card window are rewritten to the card
# model with the highspeed auth set (X-Highspeed-Card-ID) and stay unsigned,
# exactly like the official client. The loop self-extinguishes 5 minutes after
# the last eligible request; account unavailability (503/3404) is
# negative-cached 10min, HTTP 429 backs off 5s. task_id reuses the local
# client-session affinity inference. Env override: ZCODE_HIGHSPEED_ENABLED=false.
highspeed:
  enabled: true
  origin: "https://zcode.z.ai"
  models: ["glm-5.3", "glm-5.2", "glm-5.1"]

logging:
  level: info
`;
