/**
 * Official plugin-MCP relay: inbound `/mcp/{server}` requests →
 * `{origin}/api/v1/mcp/server/{routeId}` with the desktop's `zcode_official`
 * credential injection.
 *
 * Header contract — LIVE-VERIFIED 2026-09-25 against
 * `https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha` (initialize →
 * 200 + serverInfo `zcode-official-mcp`):
 *   Authorization: Bearer <zcode JWT>                        (Credential.jwt)
 *   X-Bigmodel-Authorization: Bearer <coding-plan API key>   (credentialString)
 *   Bigmodel-Target-Type: PERSONAL                           (individual plan)
 *
 * Corrections vs the 3.14.3 host bundle reading (see NOTEPAD §F): the bundle's
 * `tw`/`nw` suggests the plan header carries the raw OAuth access token from
 * the `oauth:{family}:access_token` slot — but that slot is `enc:v1:`-encrypted
 * in the desktop store (content unverifiable), and the API-key variant is what
 * actually authenticates. Identity-only (Authorization alone) is rejected by
 * the gateway with JSON-RPC 3101 "coding plan is required", so start-plan
 * credentials cannot serve this plane at all (routes surface that as 400
 * `mcp_plan_unsupported`, mirroring the async-route pattern).
 *
 * @see _reverse/NOTEPAD.md "Official plugin MCP"
 */
import { credentialString, type Credential } from "../auth/types.js";

export type OfficialMcpAuthMode = "coding-plan";
export type McpCredentialReason = "missing_jwt";

export class McpCredentialsUnavailableError extends Error {
  constructor(
    public readonly reason: McpCredentialReason,
    message: string,
  ) {
    super(message);
    this.name = "McpCredentialsUnavailableError";
  }
}

export interface OfficialMcpAuth {
  mode: OfficialMcpAuthMode;
  headers: Record<string, string>;
}

/**
 * Build the official-MCP auth headers for a coding-plan credential.
 * @throws McpCredentialsUnavailableError when the credential has no zcode JWT.
 */
export function buildOfficialMcpAuthHeaders(cred: Credential): OfficialMcpAuth {
  const jwt = cred.jwt?.trim();
  if (!jwt) {
    throw new McpCredentialsUnavailableError(
      "missing_jwt",
      "stored credential has no ZCode JWT — re-run `auth login` (or `auth login <provider> --import`) to use the /mcp relay",
    );
  }
  return {
    mode: "coding-plan",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Bigmodel-Authorization": `Bearer ${credentialString(cred).trim()}`,
      "Bigmodel-Target-Type": "PERSONAL",
    },
  };
}

/**
 * Client headers forwarded to the gateway. `authorization` is deliberately
 * absent: the inbound proxy API key must never reach the upstream, and the
 * relay's own credential headers override it regardless.
 */
const FORWARD_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

/** Response headers surfaced back to the client (session binding + type). */
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"] as const;

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

export interface McpRelayResult {
  response: Response;
}

/**
 * Forward one MCP streamable-HTTP exchange (POST JSON-RPC / GET SSE stream /
 * DELETE session close) to the official gateway. The response body streams
 * through untouched so SSE works; `req.signal` ties the upstream connection
 * to the client's lifetime.
 */
export async function relayOfficialMcpRequest(
  req: Request,
  auth: OfficialMcpAuth,
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpRelayResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    if (value !== "" && FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  // Auth headers last: the injected credentials win over anything a client
  // could smuggle into the forward set.
  for (const [name, value] of Object.entries(auth.headers)) headers[name] = value;

  const init: RequestInit = {
    method: req.method,
    headers,
    signal: req.signal,
    ...(METHODS_WITH_BODY.has(req.method) ? { body: await req.arrayBuffer() } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, init);
  } catch (err) {
    return {
      response: new Response(
        JSON.stringify({
          error: {
            type: "mcp_upstream_unreachable",
            message: `official MCP gateway unreachable: ${(err as Error).message}`,
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    };
  }

  const respHeaders: Record<string, string> = {};
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) respHeaders[name] = value;
  }
  return { response: new Response(upstream.body, { status: upstream.status, headers: respHeaders }) };
}
