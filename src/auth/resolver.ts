import type { Credential } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import type { FetchFn } from "./oauth.js";

const ZAI_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "\u9ED8\u8BA4\u673A\u6784"; // 默认机构
const DEFAULT_PROJECT_MARKER = "\u9ED8\u8BA4\u9879\u76EE"; // 默认项目

async function requestBizApi(
  fetchImpl: FetchFn,
  url: string,
  authorization: string,
  init?: RequestInit,
): Promise<any> {
  const resp = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`Biz API ${url} failed: ${resp.status}`);
  }
  const body = await resp.json();
  const code = body.code ?? body.status;
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new Error(body.msg ?? `Biz API error ${code}`);
  }
  return body.data ?? body;
}

export class KeyResolver {
  constructor(private fetchImpl: FetchFn = fetch) {}

  async resolveZaiBizToken(accessToken: string): Promise<string> {
    const resp = await this.fetchImpl("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
    });
    if (!resp.ok) {
      throw new Error(`z/login failed: ${resp.status}`);
    }
    const data = await resp.json();
    const token = data.access_token ?? data.accessToken ?? data.data?.access_token;
    // Shape guard: silently returning undefined used to store a bogus
    // credential that surfaced only as cryptic upstream 401s.
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("z/login returned unexpected shape: access_token missing or empty");
    }
    return token;
  }

  async resolveCustomerInfo(
    host: string,
    authorization: string,
  ): Promise<{ orgId: string; projectId: string }> {
    const data = await requestBizApi(
      this.fetchImpl,
      `${host}/api/biz/customer/getCustomerInfo`,
      authorization,
      { method: "GET" },
    );

    const orgs: any[] = data.organizations ?? data.orgs ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("No organizations found");
    }
    const org = orgs.find((o) =>
      (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER),
    ) ?? orgs[0];
    const orgId = org.organizationId ?? org.id ?? org.orgId;

    const projects: any[] = org.projects ?? [];
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error("No projects found in default organization");
    }
    const project = projects.find((p) =>
      (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER),
    ) ?? projects[0];
    const projectId = project.projectId ?? project.id;

    return { orgId, projectId };
  }

  async findOrCreateApiKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
  ): Promise<{ apiKey: string }> {
    const listUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;

    let existing: any[] = [];
    try {
      existing = await requestBizApi(this.fetchImpl, listUrl, authorization, { method: "GET" }) ?? [];
    } catch { /* ignore — will create */ }

    if (Array.isArray(existing)) {
      const found = existing.find((k: any) => k.name === ZAI_API_KEY_NAME);
      // Reuse the listed key only when it has a usable shape; a malformed
      // entry falls through to the create path instead of poisoning the
      // stored credential.
      if (found && typeof found.apiKey === "string" && found.apiKey.length > 0) {
        return { apiKey: found.apiKey };
      }
    }

    const created = await requestBizApi(this.fetchImpl, listUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    });
    // Shape guard (CL-06): an upstream response drift (renamed/nested field)
    // must fail the login with a clear error — not store the string
    // "undefined" and 401 on every later request.
    if (typeof created?.apiKey !== "string" || created.apiKey.length === 0) {
      throw new Error("API key creation returned unexpected shape: apiKey missing or empty");
    }
    return { apiKey: created.apiKey };
  }

  async getSecretKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
    apiKey: string,
  ): Promise<string> {
    const url = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`;
    const data = await requestBizApi(this.fetchImpl, url, authorization, { method: "GET" });
    return data.secretKey ?? data.secret_key ?? "";
  }

  async resolveCodingPlanCredential(
    accessToken: string,
    provider: ProviderId,
    userId?: string,
  ): Promise<Credential> {
    if (provider === "zai") {
      const bizToken = await this.resolveZaiBizToken(accessToken);
      const host = "https://api.z.ai";
      const authorization = `Bearer ${bizToken}`;

      const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
      const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);
      let secret: string | undefined;
      try {
        secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      } catch { /* credential will be apiKey-only */ }

      return { apiKey, secret: secret || undefined, provider: "zai", userId };
    }

    const host = "https://bigmodel.cn";
    const authorization = accessToken;

    const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
    const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);

    let fullKey = apiKey;
    try {
      const secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      if (secret) fullKey = `${apiKey}.${secret}`;
    } catch { /* use apiKey only */ }

    return { apiKey: fullKey, provider: "bigmodel", userId };
  }
}
