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
  # "apikey"  = use a pre-obtained API key directly
  # "oauth"   = use OAuth login flow (run \`bun run src/index.ts auth login\` first)
  mode: apikey

  # For apikey mode:
  #   Z.AI:     "yourApiKey.yourSecretKey"
  #   Bigmodel: "yourApiKey"
  apiKey: "YOUR_API_KEY_HERE"

  # Key that clients must provide to use the proxy.
  # Set to null/omit to disable client auth.
  proxyApiKey: "your-proxy-secret"

  # For oauth mode (path to stored credentials from login flow):
  # oauthCredentialsPath: "~/.zcode-proxy/credentials.json"

# Which upstream provider to use: "zai" or "bigmodel"
provider: zai

# Which plan tier to use:
#   "coding-plan" (default) — direct upstream endpoints, permanent API key
#   "start-plan"            — routes through zcode.z.ai with JWT auth (requires \`auth login\`)
plan: coding-plan

providers:
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"

defaultModel: glm-4.6

models:
  - glm-4.5-air
  - glm-4.6
  - glm-4.6v
  - glm-4.7
  - glm-5
  - glm-5-turbo
  - glm-5v-turbo
  - glm-5.1
  - glm-5.2
  - glm-5.3

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-ZCode-App-Version, X-Title,
# X-ZCode-Agent, HTTP-Referer). Runtime platform headers (X-Platform,
# X-Os-Category, X-Os-Version) are detected dynamically and are not configured
# here. All fields below are optional; env vars override YAML, which overrides
# defaults.
identity:
  # Mirrors process.env.ZCODE_APP_VERSION in the ZCode bundle.
  # Must be printable ASCII; non-conforming values fall back to the default.
  # Default: "3.9.1" (current ZCode release). Override to match your real client.
  appVersion: "3.9.1"
  # X-Title suffix → "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"
  # Device identity (X-Device-Mid) — random UUIDv4, generated ONCE and reused
  # forever (mirrors ZCode's telemetry deviceMid; no hardware values involved).
  # Auto-generated into this file at first \`auth login\` or config creation.
  # Leave empty on Android — the app injects ZCODE_IDENTITY_DEVICE_MID instead.
  deviceMid: ""

# Local client-session inference for cache-affinity experiments.
# "observe" (default) logs inferred sessions in debug mode but does not change
# upstream x-session-id. "enforce" reuses a stable x-session-id for inferred
# coding-plan sessions. "off" disables inference entirely.
clientIdentity:
  mode: observe
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

# Client request signing V4 (mirrors the ZCode 3.9.1 ClientRequestSigningV4Signer).
# When enabled, the proxy probes {origin}/api/v1/agent/configs (cached 1h) and,
# only if the server sets data.codingPlanSignature.enable=true, signs coding-plan
# requests: handshake against {provider}/api/paas/c1f3a7e2/v2/client, Ed25519
# signature + proof-of-work headers on every request, fail-open retry ladder
# (two 401 VERIFY rejections -> permanent unsigned bypass). Start-plan and
# off-peak paths are never signed. Env override: ZCODE_CLIENT_SIGNING=false.
clientSigning:
  enabled: true
  origin: "https://zcode.z.ai"

logging:
  level: info
`;
