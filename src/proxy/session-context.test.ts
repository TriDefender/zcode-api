/**
 * Tests for unified session context policy.
 */
import { describe, expect, it } from "bun:test";
import type { ProxyConfig } from "../config/types.js";
import { createClientSessionResolver } from "./client-session.js";
import { resolveSessionContext, sessionIdForHeader, shouldForwardSessionId } from "./session-context.js";

const BASE_CONFIG: ProxyConfig = {
  server: { port: 8080, host: "0.0.0.0" },
  auth: { mode: "apikey", apiKey: "dummy" },
  provider: "zai",
  plan: "start-plan",
  providers: {
    zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
    bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
  },
  defaultModel: "glm-4.6",
  models: ["glm-4.6"],
  identity: {
    appVersion: "3.2.2",
    sourceTitle: "zcode",
    refererOrigin: "https://zcode.z.ai",
  },
  clientIdentity: { mode: "observe", ttlSeconds: 900, maxSessions: 1024 },
  logging: { level: "info" },
};

describe("session context", () => {
  it("uses the same lineage resolver regardless of plan-specific caller", () => {
    const resolver = createClientSessionResolver();
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const req = new Request("http://localhost:8080/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const session = resolveSessionContext({
      clientReq: req,
      body,
      upstreamFormat: "openai",
      model: "glm-4.6",
      config: BASE_CONFIG,
      resolver,
    });

    expect(session?.source).toBe("lineage");
    expect(session?.action).toBe("observe");
    expect(session?.upstreamSessionId).toBeTruthy();
  });

  it("does not resolve any session when clientIdentity mode is off", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "Hi" }] });
    const session = resolveSessionContext({
      clientReq: new Request("http://localhost:8080/v1/chat/completions", { method: "POST", body }),
      body,
      upstreamFormat: "openai",
      model: "glm-4.6",
      config: { ...BASE_CONFIG, clientIdentity: { ...BASE_CONFIG.clientIdentity, mode: "off" } },
    });

    expect(session).toBeUndefined();
  });

  it("forwards session IDs only for explicit or enforce contexts", () => {
    expect(shouldForwardSessionId({
      source: "lineage",
      action: "observe",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBe(false);
    expect(sessionIdForHeader({
      source: "lineage",
      action: "observe",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBeUndefined();
    expect(sessionIdForHeader({
      source: "lineage",
      action: "enforce",
      upstreamSessionId: "11111111-1111-4111-8111-111111111111",
    })).toBe("11111111-1111-4111-8111-111111111111");
    expect(sessionIdForHeader({
      source: "explicit",
      action: "observe",
      upstreamSessionId: "sess_thread_1",
    })).toBe("sess_thread_1");
  });
});
