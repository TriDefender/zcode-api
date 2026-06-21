/**
 * OpenAI Responses API route (Codex wire_api=responses).
 */
import { proxyRequest, errorResponse, type ProxyHandlerOptions } from "../proxy/handler.js";
import { translateResponsesToAnthropic } from "../translator/responses-to-anthropic.js";

/** Handle POST /responses and POST /v1/responses. */
export async function handleResponses(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const raw = await req.text();
  if (!raw) {
    return errorResponse(400, "invalid_request_error", "Missing request body");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "invalid_request_error", "Invalid JSON in Responses API body");
  }

  if (process.env.ZCODE_PROXY_LOG_RESPONSES === "1") {
    try {
      await Bun.write("/tmp/last-responses-req.json", JSON.stringify(parsed, null, 2));
    } catch {
      // ignore
    }
  }

  const anthropic = translateResponsesToAnthropic(parsed);
  const syntheticReq = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(anthropic),
  });

  return proxyRequest(syntheticReq, "anthropic", { ...opts, responseBridge: "responses" });
}
