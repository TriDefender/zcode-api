/**
 * Async (off-peak) route handlers — thin adapters from the HTTP layer to
 * `src/async/handler.ts`. Mirrors the `routes-responses.ts` pattern.
 *
 * Route registration lives in `server.ts:createFetchHandler` (gated by
 * `config.async.enabled`). Per-route Node socket timeout extension lives
 * in `server.ts:startServer` (24h for `/async/*`; default 600s elsewhere).
 */
import {
  handleAsyncMessages,
  handleAsyncChat,
  handleAsyncHealth,
  type AsyncHandlerOptions,
} from "../async/handler.js";

export { handleAsyncMessages, handleAsyncChat, handleAsyncHealth, type AsyncHandlerOptions };

export async function handleAsyncMessagesRoute(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  return handleAsyncMessages(req, opts);
}

export async function handleAsyncChatRoute(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  return handleAsyncChat(req, opts);
}

export async function handleAsyncHealthRoute(req: Request, opts: AsyncHandlerOptions): Promise<Response> {
  return handleAsyncHealth(req, opts);
}
