/**
 * Responses-format route handler: POST /v1/responses.
 */
import { handleResponses, type ResponsesHandlerOptions } from "../proxy/responses-handler.js";

/** Handle POST /v1/responses — translate Responses API to the GLM Chat Completions upstream. */
export async function handleResponsesRoute(
  req: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  return handleResponses(req, opts);
}
