/**
 * YAML config loader with env-var overrides and validation.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { ClientIdentityConfig, ProxyConfig, ProviderEndpoints, ProxyIdentity } from "./types.js";

/** Environment variable keys that override YAML values. */
const ENV = {
  PORT: "ZCODE_PROXY_PORT",
  PROXY_API_KEY: "ZCODE_PROXY_API_KEY",
  PROVIDER: "ZCODE_PROVIDER",
  API_KEY: "ZCODE_API_KEY",
  APP_VERSION: "ZCODE_APP_VERSION",
  SOURCE_TITLE: "ZCODE_SOURCE_TITLE",
  REFERER_ORIGIN: "ZCODE_REFERER_ORIGIN",
} as const;

const DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  PROVIDER: "zai" as const,
  PLAN: "coding-plan" as const,
  DEFAULT_MODEL: "glm-4.6",
  LOG_LEVEL: "info" as const,
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  APP_VERSION: "3.2.2",
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  CLIENT_IDENTITY_MODE: "observe" as const,
  CLIENT_IDENTITY_TTL_SECONDS: 900,
  CLIENT_IDENTITY_MAX_SESSIONS: 1024,
};

/** Printable-ASCII gate copied from the ZCode bundle's `rYn` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

/**
 * Load and validate proxy configuration from a YAML file, applying env overrides.
 * @throws Error if file not found or required fields are invalid.
 */
export function loadConfig(path: string): ProxyConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw) ?? {};

  // --- server ---
  const port = resolvePort(process.env[ENV.PORT] ?? parsed?.server?.port);
  const host = typeof parsed?.server?.host === "string" ? parsed.server.host : DEFAULTS.HOST;

  // --- auth ---
  const proxyApiKey = process.env[ENV.PROXY_API_KEY] ?? parsed?.auth?.proxyApiKey;
  const mode = parsed?.auth?.mode === "oauth" ? "oauth" : "apikey";
  const apiKey = process.env[ENV.API_KEY] ?? parsed?.auth?.apiKey;
  const oauthCredentialsPath = parsed?.auth?.oauthCredentialsPath;

  // --- provider ---
  const provider = resolveProvider(process.env[ENV.PROVIDER] ?? parsed?.provider);
  const plan = resolvePlan(parsed?.plan);

  // --- providers ---
  const zai: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.zai?.anthropicBase ?? DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.zai?.openaiBase ?? DEFAULTS.ZAI_OPENAI_BASE,
    credential: parsed?.providers?.zai?.credential,
  };
  const bigmodel: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.bigmodel?.anthropicBase ?? DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.bigmodel?.openaiBase ?? DEFAULTS.BIGMODEL_OPENAI_BASE,
    credential: parsed?.providers?.bigmodel?.credential,
  };

  // --- models ---
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = Array.isArray(parsed?.models) ? parsed.models : [defaultModel];

  // --- logging ---
  const logLevel = resolveLogLevel(parsed?.logging?.level);

  // --- identity ---
  const identity = resolveIdentity({
    appVersionEnv: process.env[ENV.APP_VERSION],
    appVersionYaml: parsed?.identity?.appVersion,
    sourceTitleEnv: process.env[ENV.SOURCE_TITLE],
    sourceTitleYaml: parsed?.identity?.sourceTitle,
    refererEnv: process.env[ENV.REFERER_ORIGIN],
    refererYaml: parsed?.identity?.refererOrigin,
  });

  const clientIdentity = resolveClientIdentity(parsed?.clientIdentity);

  const config: ProxyConfig = {
    server: { port, host },
    auth: { proxyApiKey, mode, apiKey, oauthCredentialsPath },
    provider,
    plan,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    identity,
    clientIdentity,
    logging: { level: logLevel },
  };

  validate(config);
  return config;
}

function resolveClientIdentity(raw: unknown): ClientIdentityConfig {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const mode = resolveClientIdentityMode(obj.mode);
  const ttlSeconds = resolvePositiveInt(obj.ttlSeconds, DEFAULTS.CLIENT_IDENTITY_TTL_SECONDS, "clientIdentity.ttlSeconds");
  const maxSessions = resolvePositiveInt(obj.maxSessions, DEFAULTS.CLIENT_IDENTITY_MAX_SESSIONS, "clientIdentity.maxSessions");
  return { mode, ttlSeconds, maxSessions };
}

function resolveClientIdentityMode(raw: unknown): ClientIdentityConfig["mode"] {
  if (raw === undefined || raw === null) return DEFAULTS.CLIENT_IDENTITY_MODE;
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  throw new Error(`Invalid clientIdentity.mode "${String(raw)}": must be "off", "observe", or "enforce"`);
}

function resolvePositiveInt(raw: unknown, fallback: number, name: string): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/** Resolve port from raw value (YAML or env), defaulting to 8080. */
function resolvePort(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULTS.PORT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    throw new Error("server.port must be a valid number");
  }
  return n;
}

/** Resolve and validate provider string. */
function resolveProvider(raw: unknown): "zai" | "bigmodel" {
  const v = typeof raw === "string" ? raw : DEFAULTS.PROVIDER;
  if (v !== "zai" && v !== "bigmodel") {
    throw new Error(`Invalid provider "${v}": must be "zai" or "bigmodel"`);
  }
  return v;
}

function resolvePlan(raw: unknown): "coding-plan" | "start-plan" {
  if (raw === "start-plan") return "start-plan";
  return DEFAULTS.PLAN;
}

/** Resolve log level with fallback. */
function resolveLogLevel(raw: unknown): "debug" | "info" | "warn" | "error" {
  const levels = ["debug", "info", "warn", "error"] as const;
  if (typeof raw === "string" && levels.includes(raw as any)) {
    return raw as any;
  }
  return DEFAULTS.LOG_LEVEL;
}

interface IdentityInputs {
  appVersionEnv?: string;
  appVersionYaml?: string;
  sourceTitleEnv?: string;
  sourceTitleYaml?: string;
  refererEnv?: string;
  refererYaml?: string;
}

/** Resolve identity fields (env > YAML > default). Non-ASCII `appVersion` silently falls back to the default. */
function resolveIdentity(inp: IdentityInputs): ProxyIdentity {
  const rawVersion = (inp.appVersionEnv ?? inp.appVersionYaml ?? DEFAULTS.APP_VERSION).trim();
  const appVersion = ASCII_PRINTABLE.test(rawVersion) ? rawVersion : DEFAULTS.APP_VERSION;

  const sourceTitle = (inp.sourceTitleEnv ?? inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim()
    || DEFAULTS.SOURCE_TITLE;

  const refererOrigin = (inp.refererEnv ?? inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim()
    || DEFAULTS.REFERER_ORIGIN;

  return { appVersion, sourceTitle, refererOrigin };
}

/** Cross-field validation after all fields are resolved. */
function validate(config: ProxyConfig): void {
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (1-65535)`);
  }

  if (config.auth.mode === "apikey") {
    const hasGlobal = typeof config.auth.apiKey === "string" && config.auth.apiKey.length > 0;
    const hasProvider = typeof config.providers[config.provider].credential === "string";
    if (!hasGlobal && !hasProvider) {
      throw new Error(
        `auth.apiKey is required when auth.mode is "apikey" (or set providers.${config.provider}.credential)`,
      );
    }
  }

  if (!config.models.includes(config.defaultModel)) {
    // defaultModel not in the models list — add it automatically
    config.models.push(config.defaultModel);
  }
}
