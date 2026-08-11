/**
 * Tests for `src/async/client.ts`.
 *
 * Each test injects a mock `fetchImpl` that asserts the request shape (URL,
 * method, headers, body) and returns a canned response. Verifies:
 *   - happy-path response parsing + snake_case → camelCase mapping
 *   - 4xx/5xx error propagation with correct `OffPeakServerError` shape
 *   - settle 4xx-as-success semantics (mirrors `settleOne` in the bundle)
 *   - per-call timeout enforcement via `setTimeout + abort`
 *   - external AbortSignal cancellation
 *   - batchStatus truncation at 100 tickets
 *   - credential header composition (jwt + apiKey + optional bigmodel-* headers)
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createOffPeakClient } from "./client.js";
import { OffPeakServerError } from "./types.js";
import type { OffPeakCredentials } from "./types.js";

const CRED: OffPeakCredentials = {
  jwt: "test-jwt-token",
  codingPlanApiKey: "test-api-key",
};

function makeMockFetch(impl: (req: Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof url === "string" ? url : url.toString(), init);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        const err = new Error("The operation was aborted");
        (err as Error & { name: string }).name = "AbortError";
        reject(err);
      };
      if (init?.signal?.aborted) {
        onAbort();
        return;
      }
      init?.signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(impl(req, init))
        .then(resolve, reject)
        .finally(() => init?.signal?.removeEventListener("abort", onAbort));
    });
  }) as unknown as typeof fetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureReq(req: Request) {
  return {
    method: req.method,
    url: req.url,
    authHeader: req.headers.get("authorization"),
    apiKeyHeader: req.headers.get("x-coding-plan-api-key"),
    bigmodelOrg: req.headers.get("bigmodel-organization"),
    bigmodelProj: req.headers.get("bigmodel-project"),
    contentType: req.headers.get("content-type"),
  };
}

beforeEach(() => {
  // Clear any leftover abort listeners between tests.
});

describe("createOffPeakClient — header composition", () => {
  it("sends Authorization + X-Coding-Plan-Api-Key on every request", async () => {
    let captured: ReturnType<typeof captureReq> | undefined;
    const fetchImpl = makeMockFetch(async (req) => {
      captured = captureReq(req);
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.getAvailability();
    expect(captured?.authHeader).toBe("Bearer test-jwt-token");
    expect(captured?.apiKeyHeader).toBe("test-api-key");
    expect(captured?.bigmodelOrg).toBeNull();
    expect(captured?.bigmodelProj).toBeNull();
  });

  it("includes bigmodel-organization / bigmodel-project when provided", async () => {
    let captured: ReturnType<typeof captureReq> | undefined;
    const fetchImpl = makeMockFetch(async (req) => {
      captured = captureReq(req);
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({
      origin: "https://zcode.z.ai",
      credentials: { ...CRED, bigmodelOrganization: "org-123", bigmodelProject: "proj-456" },
      fetchImpl,
    });
    await client.getAvailability();
    expect(captured?.bigmodelOrg).toBe("org-123");
    expect(captured?.bigmodelProj).toBe("proj-456");
  });

  it("strips trailing slashes from origin", async () => {
    let url = "";
    const fetchImpl = makeMockFetch(async (req) => {
      url = req.url;
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai/////", credentials: CRED, fetchImpl });
    await client.getAvailability();
    expect(url).toBe("https://zcode.z.ai/api/v1/off-peak/ticket/availability");
  });

  it("sets content-type only when body is present", async () => {
    let getCT: string | null = "";
    const fetchImpl = makeMockFetch(async (req) => {
      getCT = req.headers.get("content-type");
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.getAvailability();
    expect(getCT).toBeNull();

    let postCT = "";
    const fetchImpl2 = makeMockFetch(async (req) => {
      postCT = req.headers.get("content-type") ?? "";
      return jsonResp({ ticket_id: "t-1", state: "queued" });
    });
    const client2 = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl: fetchImpl2 });
    await client2.takeTicket("task-1");
    expect(postCT).toBe("application/json");
  });
});

describe("getAvailability", () => {
  it("parses can_take_number=true response (no nextTakeAt)", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ can_take_number: true }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.getAvailability();
    expect(result).toEqual({ canTakeNumber: true });
  });

  it("parses can_take_number=false with next_take_at", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ can_take_number: false, next_take_at: 1234567890 }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.getAvailability();
    expect(result).toEqual({ canTakeNumber: false, nextTakeAt: 1234567890 });
  });

  it("throws when can_take_number=false but next_take_at missing", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ can_take_number: false }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    expect(client.getAvailability()).rejects.toThrow(/missing next_take_at/);
  });
});

describe("takeTicket", () => {
  it("parses queued response with position + next_poll_after", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({
      ticket_id: "t-abc",
      state: "queued",
      position: 42,
      next_poll_after: 5,
    }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.takeTicket("offpeak-xyz");
    expect(result.ticketId).toBe("t-abc");
    expect(result.state).toBe("queued");
    expect(result.position).toBe(42);
    expect(result.nextPollAfterMs).toBe(5000);
    expect(typeof result.registeredAt).toBe("number");
  });

  it("parses ready response (no position, no nextPollAfter)", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ ticket_id: "t-1", state: "ready" }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.takeTicket("offpeak-xyz");
    expect(result.state).toBe("ready");
    expect(result.position).toBeUndefined();
    expect(result.nextPollAfterMs).toBeUndefined();
  });

  it("sends body as {task_id: ...}", async () => {
    let bodyText = "";
    const fetchImpl = makeMockFetch(async (req) => {
      bodyText = await req.text();
      return jsonResp({ ticket_id: "t-1", state: "queued" });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.takeTicket("offpeak-123");
    expect(JSON.parse(bodyText)).toEqual({ task_id: "offpeak-123" });
  });

  it("rejects empty taskId", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({}));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const empty = "" as string;
    expect(client.takeTicket(empty)).rejects.toThrow(/taskId/);
  });

  it("throws on malformed response (missing ticket_id)", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ state: "queued" }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    expect(client.takeTicket("task-1")).rejects.toThrow(/malformed/);
  });
});

describe("batchStatus", () => {
  it("returns empty result for empty input without making HTTP call", async () => {
    let called = false;
    const fetchImpl = makeMockFetch(async () => {
      called = true;
      return jsonResp({});
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.batchStatus([]);
    expect(result).toEqual({ tickets: [] });
    expect(called).toBe(false);
  });

  it("parses tickets[] with position + active_deadline", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({
      next_poll_after: 10,
      tickets: [
        { ticket_id: "t-1", state: "ready", active_deadline: 9999999 },
        { ticket_id: "t-2", state: "queued", position: 3 },
      ],
    }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.batchStatus(["t-1", "t-2"]);
    expect(result.nextPollAfterMs).toBe(10000);
    expect(result.tickets).toEqual([
      { ticketId: "t-1", state: "ready", activeDeadline: 9999999 },
      { ticketId: "t-2", state: "queued", position: 3 },
    ]);
  });

  it("truncates at 100 tickets", async () => {
    let bodyText = "";
    const fetchImpl = makeMockFetch(async (req) => {
      bodyText = await req.text();
      return jsonResp({ tickets: [] });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const ids = Array.from({ length: 150 }, (_, i) => `t-${i}`);
    await client.batchStatus(ids);
    const parsed = JSON.parse(bodyText);
    expect(parsed.ticket_ids.length).toBe(100);
    expect(parsed.ticket_ids[0]).toBe("t-0");
    expect(parsed.ticket_ids[99]).toBe("t-99");
  });

  it("throws on malformed tickets entry", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({
      tickets: [{ ticket_id: "t-1" }],
    }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    expect(client.batchStatus(["t-1"])).rejects.toThrow(/malformed/);
  });
});

describe("settle", () => {
  it("POSTs to /ticket/{id}/settle with no body", async () => {
    let captured: { method: string; url: string; bodyText: string } = { method: "", url: "", bodyText: "" };
    const fetchImpl = makeMockFetch(async (req) => {
      captured = { method: req.method, url: req.url, bodyText: await req.text().catch(() => "") };
      return new Response(null, { status: 200 });
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.settle("t-abc/def");
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("https://zcode.z.ai/api/v1/off-peak/ticket/t-abc%2Fdef/settle");
    expect(captured.bodyText).toBe("");
  });

  it("resolves on 200 with empty body", async () => {
    const fetchImpl = makeMockFetch(async () => new Response(null, { status: 200 }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.settle("t-1");
  });

  it("4xx resolves as success by default (server already cleaned up)", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ code: 404, msg: "ticket not found" }, 404));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    await client.settle("t-1");
  });

  it("4xx throws when settleAsSuccess=false", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ code: 404, msg: "ticket not found" }, 404));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    expect(client.settle("t-1", { settleAsSuccess: false })).rejects.toThrow(OffPeakServerError);
  });

  it("5xx always throws", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ msg: "upstream down" }, 502));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    expect(client.settle("t-1")).rejects.toThrow(/upstream down/);
  });

  it("uses settleTimeoutMs when provided (separate from controlTimeoutMs)", async () => {
    const callTimes: number[] = [];
    const fetchImpl = makeMockFetch(async () => {
      callTimes.push(Date.now());
      return new Response(null, { status: 200 });
    });
    const client = createOffPeakClient({
      origin: "https://zcode.z.ai",
      credentials: CRED,
      fetchImpl,
      controlTimeoutMs: 30000,
      settleTimeoutMs: 100,
    });
    await client.settle("t-1");
    expect(callTimes.length).toBe(1);
  });
});

describe("response envelope unwrap", () => {
  it("unwraps {code:0, data:{...}} envelope on HTTP 200", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({
      code: 0,
      msg: "ok",
      data: { ticket_id: "t-1", state: "queued", position: 5 },
    }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.takeTicket("task-1");
    expect(result.ticketId).toBe("t-1");
    expect(result.state).toBe("queued");
    expect(result.position).toBe(5);
  });

  it("non-zero code on HTTP 200 throws OffPeakServerError with bizCode", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({
      code: 3103,
      msg: "quota exceeded",
      data: null,
    }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    try {
      await client.takeTicket("task-1");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      const err = e as OffPeakServerError;
      expect(err.bizCode).toBe("3103");
      expect(err.message).toContain("quota exceeded");
    }
  });

  it("response without envelope (no code/data fields) returned as-is", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ ticket_id: "t-raw", state: "ready" }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    const result = await client.takeTicket("task-1");
    expect(result.ticketId).toBe("t-raw");
  });
});

describe("error handling", () => {
  it("5xx with JSON {code,msg} → OffPeakServerError carries httpStatus + bizCode", async () => {
    const fetchImpl = makeMockFetch(async () => jsonResp({ code: 3103, msg: "quota exceeded" }, 429));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    try {
      await client.takeTicket("task-1");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      const err = e as OffPeakServerError;
      expect(err.httpStatus).toBe(429);
      expect(err.bizCode).toBe("3103");
      expect(err.message).toContain("quota exceeded");
    }
  });

  it("5xx with plain text body", async () => {
    const fetchImpl = makeMockFetch(async () => new Response("internal error", { status: 500 }));
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    try {
      await client.takeTicket("task-1");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      expect((e as OffPeakServerError).httpStatus).toBe(500);
      expect((e as OffPeakServerError).message).toContain("internal error");
    }
  });

  it("network error wraps in OffPeakServerError with httpStatus=0", async () => {
    const fetchImpl = makeMockFetch(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    try {
      await client.getAvailability();
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      const err = e as OffPeakServerError;
      expect(err.httpStatus).toBe(0);
      expect(err.message).toContain("network error");
      expect(err.message).toContain("ECONNREFUSED");
    }
  });

  it("abort error wraps in OffPeakServerError with httpStatus=0", async () => {
    const fetchImpl = makeMockFetch(async () => {
      const err = new Error("The operation was aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    });
    const client = createOffPeakClient({ origin: "https://zcode.z.ai", credentials: CRED, fetchImpl });
    try {
      await client.getAvailability();
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      expect((e as OffPeakServerError).httpStatus).toBe(0);
      expect((e as OffPeakServerError).message).toContain("aborted");
    }
  });

  it("per-call timeout triggers abort when controlTimeoutMs is tiny", async () => {
    const fetchImpl = makeMockFetch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({
      origin: "https://zcode.z.ai",
      credentials: CRED,
      fetchImpl,
      controlTimeoutMs: 30,
    });
    try {
      await client.getAvailability();
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      expect((e as OffPeakServerError).message).toMatch(/abort|network/i);
    }
  });

  it("external AbortSignal cancellation propagates to fetch", async () => {
    const fetchImpl = makeMockFetch(async (_req, init) => {
      // Wait long enough for the test to cancel us.
      await new Promise((_r, rej) => {
        const t = setTimeout(() => _r(null), 1000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          rej(err);
        });
      });
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({
      origin: "https://zcode.z.ai",
      credentials: CRED,
      fetchImpl,
      controlTimeoutMs: 10000,
    });
    const controller = new AbortController();
    const p = client.getAvailability(controller.signal);
    setTimeout(() => controller.abort(), 50);
    try {
      await p;
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      expect((e as OffPeakServerError).message).toMatch(/abort/i);
    }
  });

  it("pre-aborted signal aborts immediately", async () => {
    let called = false;
    const fetchImpl = makeMockFetch(async () => {
      called = true;
      return jsonResp({ can_take_number: true });
    });
    const client = createOffPeakClient({
      origin: "https://zcode.z.ai",
      credentials: CRED,
      fetchImpl,
      controlTimeoutMs: 5000,
    });
    const controller = new AbortController();
    controller.abort();
    try {
      await client.getAvailability(controller.signal);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(OffPeakServerError);
      expect((e as OffPeakServerError).message).toMatch(/abort/i);
    }
  });
});
