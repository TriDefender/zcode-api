/**
 * Tests for config loader.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./loader.js";

const TMP = join(tmpdir(), `zcode-proxy-test-${Date.now()}`);

function writeYaml(content: string): string {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

beforeEach(() => {
  // Clean env overrides
  delete process.env.ZCODE_PROXY_PORT;
  delete process.env.ZCODE_PROXY_API_KEY;
  delete process.env.ZCODE_PROVIDER;
  delete process.env.ZCODE_API_KEY;
  delete process.env.ZCODE_APP_VERSION;
  delete process.env.ZCODE_SOURCE_TITLE;
  delete process.env.ZCODE_REFERER_ORIGIN;
  delete process.env.ZCODE_ASYNC_ENABLED;
  delete process.env.ZCODE_ASYNC_ORIGIN;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid YAML config with all fields", () => {
    const path = writeYaml(`
server:
  port: 9090
  host: "127.0.0.1"
auth:
  mode: apikey
  apiKey: "testkey.testsecret"
  proxyApiKey: "proxy-secret"
provider: bigmodel
defaultModel: glm-4.6
models:
  - glm-4.6
  - glm-4.5
logging:
  level: debug
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(9090);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.auth.apiKey).toBe("testkey.testsecret");
    expect(cfg.auth.proxyApiKey).toBe("proxy-secret");
    expect(cfg.provider).toBe("bigmodel");
    expect(cfg.defaultModel).toBe("glm-4.6");
    expect(cfg.models).toEqual(["glm-4.6", "glm-4.5"]);
    expect(cfg.logging.level).toBe("debug");
  });

  it("applies defaults for missing optional fields", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.provider).toBe("zai");
    expect(cfg.defaultModel).toBe("glm-4.6");
    expect(cfg.logging.level).toBe("info");
    expect(cfg.providers.zai.anthropicBase).toBe("https://api.z.ai/api/anthropic");
    expect(cfg.providers.bigmodel.openaiBase).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(cfg.clientIdentity).toEqual({ mode: "observe", ttlSeconds: 900, maxSessions: 1024 });
    expect(cfg.responses).toEqual({ enabled: true, storeMaxEntries: 1000, storeTtlMs: 86400000 });
    expect(cfg.mcp).toEqual({ enabled: true, webSearch: true, webReader: false, zread: false });
    expect(cfg.async).toEqual({
      enabled: false,
      origin: "https://zcode.z.ai",
      pollIntervalMs: 5000,
      keepAliveIntervalMs: 3000,
      maxWaitMs: 0,
      maxRetries: 3,
      settleTimeoutMs: 8000,
      controlTimeoutMs: 15000,
      defaultModel: "",
    });
  });

  it("clientIdentity: YAML values override defaults", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
clientIdentity:
  mode: enforce
  ttlSeconds: 60
  maxSessions: 8
`);
    const cfg = loadConfig(path);
    expect(cfg.clientIdentity).toEqual({ mode: "enforce", ttlSeconds: 60, maxSessions: 8 });
  });

  it("responses + mcp: YAML values override defaults", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
responses:
  enabled: false
  store:
    maxEntries: 50
    ttlMs: 3600000
mcp:
  enabled: true
  webSearch: false
  webReader: true
  zread: true
`);
    const cfg = loadConfig(path);
    expect(cfg.responses).toEqual({ enabled: false, storeMaxEntries: 50, storeTtlMs: 3600000 });
    expect(cfg.mcp).toEqual({ enabled: true, webSearch: false, webReader: true, zread: true });
  });

  it("async: YAML values override defaults", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  enabled: true
  origin: "https://custom.example.com"
  pollIntervalMs: 1000
  keepAliveIntervalMs: 500
  maxWaitMs: 600000
  maxRetries: 5
  settleTimeoutMs: 3000
  controlTimeoutMs: 8000
  defaultModel: "glm-5"
`);
    const cfg = loadConfig(path);
    expect(cfg.async).toEqual({
      enabled: true,
      origin: "https://custom.example.com",
      pollIntervalMs: 1000,
      keepAliveIntervalMs: 500,
      maxWaitMs: 600000,
      maxRetries: 5,
      settleTimeoutMs: 3000,
      controlTimeoutMs: 8000,
      defaultModel: "glm-5",
    });
  });

  it("async: snake_case YAML keys also accepted", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  poll_interval_ms: 2000
  keepalive_interval_ms: 700
  max_wait_ms: 300000
  max_retries: 2
  settle_timeout_ms: 4000
  control_timeout_ms: 9000
`);
    const cfg = loadConfig(path);
    expect(cfg.async.pollIntervalMs).toBe(2000);
    expect(cfg.async.keepAliveIntervalMs).toBe(700);
    expect(cfg.async.maxWaitMs).toBe(300000);
    expect(cfg.async.maxRetries).toBe(2);
    expect(cfg.async.settleTimeoutMs).toBe(4000);
    expect(cfg.async.controlTimeoutMs).toBe(9000);
  });

  it("async: ZCODE_ASYNC_ENABLED env overrides YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  enabled: false
`);
    process.env.ZCODE_ASYNC_ENABLED = "true";
    const cfg = loadConfig(path);
    expect(cfg.async.enabled).toBe(true);
  });

  it("async: maxWaitMs=0 is allowed (non-negative, not positive)", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  maxWaitMs: 0
`);
    const cfg = loadConfig(path);
    expect(cfg.async.maxWaitMs).toBe(0);
  });

  it("async: throws on negative maxWaitMs", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  maxWaitMs: -1
`);
    expect(() => loadConfig(path)).toThrow(/non-negative/);
  });

  it("async: throws on zero pollIntervalMs (must be positive)", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
async:
  pollIntervalMs: 0
`);
    expect(() => loadConfig(path)).toThrow(/positive integer/);
  });

  it("throws on invalid clientIdentity.mode", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
clientIdentity:
  mode: always
`);
    expect(() => loadConfig(path)).toThrow(/Invalid clientIdentity\.mode/);
  });

  it("env vars override YAML values", () => {
    const path = writeYaml(`
server:
  port: 9090
auth:
  mode: apikey
  apiKey: "fromyaml"
provider: zai
`);
    process.env.ZCODE_PROXY_PORT = "3000";
    process.env.ZCODE_PROXY_API_KEY = "fromenv-proxy";
    process.env.ZCODE_API_KEY = "fromenv-key";
    process.env.ZCODE_PROVIDER = "bigmodel";

    const cfg = loadConfig(path);
    expect(cfg.server.port).toBe(3000);
    expect(cfg.auth.proxyApiKey).toBe("fromenv-proxy");
    expect(cfg.auth.apiKey).toBe("fromenv-key");
    expect(cfg.provider).toBe("bigmodel");
  });

  it("throws when port is out of range", () => {
    const path = writeYaml(`
server:
  port: 99999
auth:
  mode: apikey
  apiKey: "abc"
`);
    expect(() => loadConfig(path)).toThrow(/out of range/);
  });

  it("throws on invalid provider", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
provider: openai
`);
    expect(() => loadConfig(path)).toThrow(/Invalid provider/);
  });

  it("throws when auth.apiKey missing in apikey mode", () => {
    const path = writeYaml(`
auth:
  mode: apikey
`);
    expect(() => loadConfig(path)).toThrow(/auth\.apiKey is required/);
  });

  it("does not require apiKey in oauth mode", () => {
    const path = writeYaml(`
auth:
  mode: oauth
`);
    const cfg = loadConfig(path);
    expect(cfg.auth.mode).toBe("oauth");
    expect(cfg.auth.apiKey).toBeUndefined();
  });

  it("throws when config file not found", () => {
    expect(() => loadConfig("/nonexistent/path/config.yaml")).toThrow(/not found/);
  });

  it("auto-adds defaultModel to models list if missing", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
defaultModel: glm-5
models:
  - glm-4.6
`);
    const cfg = loadConfig(path);
    expect(cfg.models).toContain("glm-5");
    expect(cfg.models).toContain("glm-4.6");
  });

  it("identity defaults to current ZCode release when no field provided", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("3.3.3");
    expect(cfg.identity.sourceTitle).toBe("cli");
    expect(cfg.identity.refererOrigin).toBe("https://zcode.z.ai");
  });

  it("identity: YAML values override defaults", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "9.9.9"
  sourceTitle: "electron"
  refererOrigin: "https://example.com"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("9.9.9");
    expect(cfg.identity.sourceTitle).toBe("electron");
    expect(cfg.identity.refererOrigin).toBe("https://example.com");
  });

  it("identity: ZCODE_APP_VERSION env overrides YAML", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "from-yaml"
`);
    process.env.ZCODE_APP_VERSION = "from-env";
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("from-env");
  });

  it("identity: non-ASCII appVersion falls back to default", () => {
    const path = writeYaml(`
auth:
  mode: apikey
  apiKey: "abc"
identity:
  appVersion: "v3.3.3-中文"
`);
    const cfg = loadConfig(path);
    expect(cfg.identity.appVersion).toBe("3.3.3");
  });
});
