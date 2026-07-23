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

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-ZCode-App-Version, X-Title,
# X-ZCode-Agent, HTTP-Referer). Runtime platform headers (X-Platform,
# X-Os-Category, X-Os-Version) are detected dynamically and are not configured
# here. All fields below are optional; env vars override YAML, which overrides
# defaults.
identity:
  # Mirrors process.env.ZCODE_APP_VERSION in the ZCode bundle.
  # Must be printable ASCII; non-conforming values fall back to the default.
  # Default: "3.3.3" (current ZCode release). Override to match your real client.
  appVersion: "3.3.3"
  # X-Title suffix → "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"

# Local client-session inference for cache-affinity experiments.
# "observe" (default) logs inferred sessions in debug mode but does not change
# upstream x-session-id. "enforce" reuses a stable x-session-id for inferred
# coding-plan sessions. "off" disables inference entirely.
clientIdentity:
  mode: observe
  ttlSeconds: 900
  maxSessions: 1024

logging:
  level: info
`;
