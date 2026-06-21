/**
 * Admin API + web dashboard backend.
 */
import type { AccountPool } from "../auth/account-pool.js";
import { errorResponse } from "../proxy/handler.js";
import { decodeJwtUserId, loadZcodeJwtFromDesktop } from "../auth/zcode-credentials.js";
import type { QuotaCache } from "../auth/quota-cache.js";
import { fetchBillingBalance } from "../auth/billing.js";
import { saveCredential } from "../auth/store.js";
import { onboardStartPlan } from "../auth/onboard.js";
import type { OnboardJobManager } from "../auth/onboard-jobs.js";
import type { RequestLogStore } from "./request-logs.js";
import type { ProxyConfig } from "../config/types.js";
import type { ProviderId } from "../provider/types.js";

export interface AdminContext {
  accountPool: AccountPool;
  config: ProxyConfig;
  onboardJobs: OnboardJobManager;
  requestLogs: RequestLogStore;
  quotaCache?: QuotaCache;
}

export function handleAdminRoute(
  req: Request,
  ctx: AdminContext,
): Promise<Response> | Response {
  const { accountPool, config, onboardJobs, requestLogs, quotaCache } = ctx;
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/admin/status" && req.method === "GET") {
    const poolEnabled =
      config.plan === "start-plan" &&
      (config.pool?.enabled !== false || accountPool.size() > 0);
    return Response.json({
      status: "ok",
      plan: config.plan,
      provider: config.provider,
      authMode: config.auth.mode,
      requiresProxyKey: Boolean(config.auth.proxyApiKey),
      pool: {
        enabled: poolEnabled,
        total: accountPool.size(),
        active: accountPool.activeCount(),
        maxAttempts: config.pool?.maxAccountAttempts ?? 5,
      },
      server: config.server,
      defaultModel: config.defaultModel,
      models: config.models,
      identity: config.identity,
      logs: requestLogs.summary(),
    });
  }

  if (path === "/admin/logs" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    return Response.json(requestLogs.list({ limit, offset }));
  }

  if (path === "/admin/quota" && req.method === "GET") {
    if (quotaCache) {
      return Response.json(quotaCache.getSnapshot());
    }
    const accounts = accountPool.list();
    return Promise.all(
      accounts.map(async (account) => {
        const { fetchBillingBalance } = await import("../auth/billing.js");
        const balance = await fetchBillingBalance(account.jwt);
        return {
          id: account.id,
          userId: account.userId,
          status: account.status,
          enabled: account.enabled,
          usageCount: account.usageCount,
          lastUsedAt: account.lastUsedAt,
          ok: balance.ok,
          serverTime: balance.serverTime,
          balances: balance.balances.map((b) => ({
            show_name: b.show_name,
            total_units: b.total_units,
            used_units: b.used_units,
            remaining_units: b.remaining_units,
            period_end: b.period_end,
            period_start: b.period_start,
          })),
          fetchedAt: Date.now(),
        };
      }),
    ).then((items) =>
      Response.json({
        accounts: items,
        cache: {
          refreshing: false,
          cycleIntervalSec: 0,
          fetchDelaySec: 0,
          nextRefreshAt: null,
          lastCompletedAt: null,
        },
      }),
    );
  }

  if (path === "/admin/accounts" && req.method === "GET") {
    return Response.json({
      accounts: accountPool.listPublic(),
      active: accountPool.activeCount(),
      total: accountPool.size(),
    });
  }

  if (path === "/admin/accounts" && req.method === "POST") {
    return req.json().then((body: { jwt?: string; provider?: ProviderId }) => {
      const jwt = body.jwt?.trim();
      if (!jwt) {
        return errorResponse(400, "invalid_request", "jwt is required");
      }
      const cred = {
        apiKey: "start-plan",
        provider: body.provider ?? "zai",
        jwt,
        userId: decodeJwtUserId(jwt),
      };
      const id = accountPool.addFromCredential(cred);
      void saveCredential(cred);
      return Response.json({ id, ok: true }, { status: 201 });
    });
  }

  if (path === "/admin/import-desktop" && req.method === "POST") {
    return (async () => {
      const jwt = loadZcodeJwtFromDesktop();
      if (!jwt) {
        return errorResponse(
          404,
          "not_found",
          "No JWT in ~/.zcode/v2/credentials.json. Log into ZCode desktop first.",
        );
      }
      const cred = {
        apiKey: "start-plan",
        provider: "zai" as const,
        jwt,
        userId: decodeJwtUserId(jwt),
      };
      await saveCredential(cred);
      const id = accountPool.addFromCredential(cred);
      return Response.json({ id, ok: true, userId: cred.userId }, { status: 201 });
    })();
  }

  if (path === "/admin/onboard/start" && req.method === "POST") {
    return req.json().then(async (body: { launchDesktop?: boolean }) => {
      try {
        const job = await onboardJobs.start({
          launchDesktop: body.launchDesktop,
          accountPool,
        });
        return Response.json(job, { status: 201 });
      } catch (err) {
        return errorResponse(500, "onboard_error", (err as Error).message);
      }
    });
  }

  const onboardMatch = path.match(/^\/admin\/onboard\/([^/]+)$/);
  if (onboardMatch && req.method === "GET") {
    const job = onboardJobs.get(onboardMatch[1]!);
    if (!job) {
      return errorResponse(404, "not_found", "onboard session not found");
    }
    return Response.json(job);
  }

  const balanceMatch = path.match(/^\/admin\/accounts\/([^/]+)\/balance$/);
  if (balanceMatch && req.method === "GET") {
    const account = accountPool.get(balanceMatch[1]!);
    if (!account) {
      return errorResponse(404, "not_found", "account not found");
    }
    return fetchBillingBalance(account.jwt).then((balance) =>
      Response.json({
        accountId: account.id,
        ok: balance.ok,
        serverTime: balance.serverTime,
        balances: balance.balances,
      }),
    );
  }

  const credentialMatch = path.match(/^\/admin\/accounts\/([^/]+)\/credential$/);
  if (credentialMatch && req.method === "GET") {
    const account = accountPool.get(credentialMatch[1]!);
    if (!account) {
      return errorResponse(404, "not_found", "account not found");
    }
    return Response.json({
      id: account.id,
      userId: account.userId,
      provider: account.provider,
      jwt: account.jwt,
      status: account.status,
      enabled: account.enabled,
    });
  }

  const provisionMatch = path.match(/^\/admin\/accounts\/([^/]+)\/provision$/);
  if (provisionMatch && req.method === "POST") {
    return req.json().then(async (body: { launchDesktop?: boolean }) => {
      const account = accountPool.get(provisionMatch[1]!);
      if (!account) {
        return errorResponse(404, "not_found", "account not found");
      }
      const accessToken =
        account.apiKey && account.apiKey !== "start-plan" ? account.apiKey : account.jwt;
      try {
        const result = await onboardStartPlan({
          provider: account.provider,
          jwt: account.jwt,
          accessToken,
          userId: account.userId,
          launchDesktop: body.launchDesktop !== false,
          quotaTimeoutMs: 300_000,
          quotaPollIntervalMs: (config.pool?.quotaFetchDelaySec ?? 5) * 1000,
        });
        if (result.quotaReady) {
          accountPool.markActive(account.id);
        }
        return Response.json({
          accountId: account.id,
          userId: account.userId,
          ok: true,
          quotaReady: result.quotaReady,
          balanceCount: result.balanceCount,
        });
      } catch (err) {
        return errorResponse(500, "provision_error", (err as Error).message);
      }
    });
  }

  const removeMatch = path.match(/^\/admin\/accounts\/([^/]+)$/);
  if (removeMatch && req.method === "DELETE") {
    const id = removeMatch[1]!;
    if (!accountPool.remove(id)) {
      return errorResponse(404, "not_found", "account not found");
    }
    return Response.json({ ok: true });
  }

  const enableMatch = path.match(/^\/admin\/accounts\/([^/]+)\/enable$/);
  if (enableMatch && req.method === "POST") {
    const id = enableMatch[1]!;
    if (!accountPool.setEnabled(id, true)) {
      return errorResponse(404, "not_found", "account not found");
    }
    return Response.json({ ok: true });
  }

  const disableMatch = path.match(/^\/admin\/accounts\/([^/]+)\/disable$/);
  if (disableMatch && req.method === "POST") {
    const id = disableMatch[1]!;
    if (!accountPool.setEnabled(id, false)) {
      return errorResponse(404, "not_found", "account not found");
    }
    return Response.json({ ok: true });
  }

  return errorResponse(404, "not_found", `No admin route for ${req.method} ${path}`);
}
