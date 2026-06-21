/**
 * Bridge OpenAI client requests to Anthropic upstream (start-plan).
 */
import type { Format, OpenAIChatRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";

export interface RequestBridge {
  body: string | undefined;
  upstreamFormat: Format;
  translateResponse: boolean;
}

/** start-plan upstream is Anthropic-only; translate OpenAI chat bodies on ingress. */
export function bridgeOpenAIRequest(
  body: string | undefined,
  clientFormat: Format,
  plan: "coding-plan" | "start-plan",
): RequestBridge {
  if (plan !== "start-plan" || clientFormat !== "openai") {
    return { body, upstreamFormat: clientFormat, translateResponse: false };
  }

  if (!body) {
    return { body, upstreamFormat: "anthropic", translateResponse: true };
  }

  const parsed = JSON.parse(body) as OpenAIChatRequest;
  const anthropic = translateRequestOpenAIToAnthropic(parsed);
  return {
    body: JSON.stringify(anthropic),
    upstreamFormat: "anthropic",
    translateResponse: true,
  };
}

/** Convert Anthropic JSON or SSE responses back to OpenAI for the client. */
export async function bridgeAnthropicResponse(
  upstream: Response,
  clientModel: string,
): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream") && upstream.body) {
    const headers = new Headers(upstream.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.delete("content-encoding");
    return new Response(anthropicSseToOpenaiSse(upstream.body, clientModel), {
      status: upstream.status,
      headers,
    });
  }

  const text = await upstream.text();
  try {
    const parsed = JSON.parse(text) as AnthropicMessagesResponse;
    if (parsed.type === "message") {
      const openai = translateResponseAnthropicToOpenAI(parsed, clientModel);
      return new Response(JSON.stringify(openai), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }
  } catch {
    // Non-JSON error bodies pass through unchanged.
  }

  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": contentType || "application/json" },
  });
}
