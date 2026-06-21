/**
 * Smoke test: server wiring must start without ReferenceError.
 */
import { describe, it, expect } from "bun:test";
import { createFetchHandler } from "./server.js";
import { AuthManager } from "../auth/manager.js";
import { AccountPool } from "../auth/account-pool.js";
import { OnboardJobManager } from "../auth/onboard-jobs.js";
import { RequestLogStore } from "./request-logs.js";
import type { ProxyConfig } from "../config/types.js";

function makeConfig(): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "oauth", proxyApiKey: "test-secret" },
    provider: "zai",
    plan: "start-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-5.2",
    models: ["glm-5.2"],
    identity: { appVersion: "3.1.2", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    pool: { enabled: true, maxAccountAttempts: 5 },
    logging: { level: "info" },
  };
}

describe("server startup wiring", () => {
  it("admin routes work with full server context", async () => {
    const config = makeConfig();
    const auth = new AuthManager({ mode: "oauth", provider: "zai" });
    const accountPool = new AccountPool();
    const onboardJobs = new OnboardJobManager();
    const requestLogs = new RequestLogStore();

    const handler = createFetchHandler({
      config,
      auth,
      accountPool,
      onboardJobs,
      requestLogs,
    });

    const app = await handler(new Request("http://localhost/app"));
    expect(app.status).toBe(200);
    const html = await app.text();
    expect(html).toContain("btn-add-account");
    expect(html).toContain("btn-show-accounts");

    const status = await handler(new Request("http://localhost/admin/status"));
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.logs).toBeDefined();

    const quota = await handler(new Request("http://localhost/admin/quota"));
    expect(quota.status).toBe(200);

    const logs = await handler(new Request("http://localhost/admin/logs"));
    expect(logs.status).toBe(200);
  });
});
