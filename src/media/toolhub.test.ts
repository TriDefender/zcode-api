/**
 * ToolHub client tests: the same-key retry ladders, state machines and error
 * taxonomy are the charged-operation safety net — every branch is pinned
 * against the plugin-derived contract (see toolhub.ts header).
 */
import { describe, it, expect } from "bun:test";
import { invokeImage, queryVideo, submitVideo, uploadFile, type ToolHubDeps } from "./toolhub.js";
import { MediaUpstreamError } from "./shared.js";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string | FormData;
}

function makeDeps(
  responder: (call: { url: string; headers: Record<string, string>; body: string | FormData }, attempt: number) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  let attempt = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    attempt += 1;
    const call: RecordedCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: (init?.body as string | FormData) ?? "",
    };
    calls.push(call);
    return await responder(call, attempt);
  }) as unknown as typeof fetch;
  const deps: ToolHubDeps = { origin: "https://zcode.test", headers: { Authorization: "Bearer jwt" }, fetchImpl: impl, retryDelayMs: 1 };
  return { deps, calls };
}

const envelope = (data: unknown, code = 0) => new Response(JSON.stringify({ code, data }), { status: 200, headers: { "content-type": "application/json" } });

function identityHeaders(call: RecordedCall): Record<string, string> {
  if (call.body instanceof FormData) {
    // FormData sets its own content-type boundary; only identity headers matter here.
    return call.headers;
  }
  return call.headers;
}

describe("invokeImage — same-key retry ladder", () => {
  it("returns the image url on a first-try SUCCEEDED", async () => {
    const { deps, calls } = makeDeps(() => envelope({ state: "SUCCEEDED", output: { image_url: "https://img.test/x.png" }, invocation_id: "inv-1" }));
    const result = await invokeImage(deps, { query: "a cat" });
    expect(result.imageUrl).toBe("https://img.test/x.png");
    expect(result.invocationId).toBe("inv-1");
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0].body as string) as { query: string; image?: string };
    expect(body).toEqual({ query: "a cat" });
    // Idempotency-Key + identity headers are the charged-call contract.
    expect(identityHeaders(calls[0])["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
    expect(identityHeaders(calls[0]).authorization).toBe("Bearer jwt");
  });

  it("retries a transient failure ONCE with the SAME Idempotency-Key", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      if (n === 1) return envelope({ code: 2007 }, 2007);
      return envelope({ state: "SUCCEEDED", output: { image_url: "https://img.test/y.png" } });
    });
    const result = await invokeImage(deps, { query: "dog" });
    expect(result.imageUrl).toBe("https://img.test/y.png");
    expect(calls.length).toBe(2);
    expect(calls[0].headers["idempotency-key"]).toBe(calls[1].headers["idempotency-key"]);
  });

  it("throws after the second transient failure (no third attempt)", async () => {
    const { deps, calls } = makeDeps(() => new Response("boom", { status: 500 }));
    await expect(invokeImage(deps, { query: "dog" })).rejects.toThrow(/image generation failed/);
    expect(calls.length).toBe(2);
  });

  it("exhausted 429s surface as rate_limit (429, not 502) without the accepted-hint", async () => {
    const { deps, calls } = makeDeps(() => new Response("slow down", { status: 429 }));
    const err = await invokeImage(deps, { query: "dog" }).catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("rate_limit");
    expect(err.message).not.toContain("may already have been accepted");
    expect(calls.length).toBe(2);
  });

  it("re-asks CALLING (same key) up to two extra times", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      if (n < 3) return envelope({ state: "CALLING" });
      return envelope({ state: "SUCCEEDED", output: { image_url: "https://img.test/z.png" } });
    });
    const result = await invokeImage(deps, { query: "bird" });
    expect(result.imageUrl).toBe("https://img.test/z.png");
    expect(calls.length).toBe(3);
    expect(calls[0].headers["idempotency-key"]).toBe(calls[2].headers["idempotency-key"]);
  });

  it("throws on UNKNOWN without retrying", async () => {
    const { deps, calls } = makeDeps(() => envelope({ state: "UNKNOWN" }));
    await expect(invokeImage(deps, { query: "bird" })).rejects.toThrow(/unconfirmed/);
    expect(calls.length).toBe(1);
  });

  it("throws on SUCCEEDED+replayed without an image url", async () => {
    const { deps } = makeDeps(() => envelope({ state: "SUCCEEDED", replayed: true, output: {} }));
    await expect(invokeImage(deps, { query: "bird" })).rejects.toThrow(/already been returned/);
  });

  it("throws on a terminal no-url SUCCEEDED without retrying", async () => {
    const { deps, calls } = makeDeps(() => envelope({ state: "SUCCEEDED", output: {} }));
    await expect(invokeImage(deps, { query: "bird" })).rejects.toThrow(/no image URL/);
    expect(calls.length).toBe(1);
  });
});

describe("uploadFile", () => {
  it("uploads multipart and returns the presigned https url", async () => {
    const { deps, calls } = makeDeps(() => envelope({ url: "https://files.test/ref.png" }));
    const url = await uploadFile(deps, new Uint8Array([1, 2, 3]), "image/png", "ref.png");
    expect(url).toBe("https://files.test/ref.png");
    expect(calls.length).toBe(1);
    expect(calls[0].body instanceof FormData).toBe(true);
    expect(calls[0].url).toBe("https://zcode.test/api/v1/toolhub/files");
  });

  it("retries a transient upload once", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      if (n === 1) return new Response("busy", { status: 500 });
      return envelope({ url: "https://files.test/ref2.png" });
    });
    const url = await uploadFile(deps, new Uint8Array([1]), "image/png", "ref2.png");
    expect(url).toBe("https://files.test/ref2.png");
    expect(calls.length).toBe(2);
  });

  it("rejects a non-https upload result", async () => {
    const { deps } = makeDeps(() => envelope({ url: "http://files.test/ref.png" }));
    await expect(uploadFile(deps, new Uint8Array([1]), "image/png", "ref.png")).rejects.toThrow(/non-https/);
  });
});

describe("submitVideo — shared Idempotency-Key across uncertain attempts", () => {
  it("returns the task id from output.task_id", async () => {
    const { deps, calls } = makeDeps(() => envelope({ state: "SUCCEEDED", output: { task_id: "task-1" }, invocation_id: "inv-9" }));
    const result = await submitVideo(deps, { query: "a drone shot" });
    expect(result).toEqual({ taskId: "task-1", invocationId: "inv-9" });
    const body = JSON.parse(calls[0].body as string) as { query: string };
    expect(body.query).toBe("a drone shot");
    expect(calls[0].headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("falls back to upstream_req_id when output.task_id is absent", async () => {
    const { deps } = makeDeps(() => envelope({ state: "SUCCEEDED", upstream_req_id: "up-1" }));
    const result = await submitVideo(deps, { query: "x" });
    expect(result.taskId).toBe("up-1");
  });

  it("retries UNKNOWN with the same key and succeeds", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      if (n === 1) return envelope({ state: "UNKNOWN" });
      return envelope({ state: "SUCCEEDED", output: { task_id: "task-2" } });
    });
    const result = await submitVideo(deps, { query: "x" });
    expect(result.taskId).toBe("task-2");
    expect(calls.length).toBe(2);
    expect(calls[0].headers["idempotency-key"]).toBe(calls[1].headers["idempotency-key"]);
  });

  it("throws WITHOUT a task id when all 4 attempts stay uncertain", async () => {
    const { deps, calls } = makeDeps(() => envelope({ state: "CALLING" }));
    await expect(submitVideo(deps, { query: "x" })).rejects.toThrow(/could not be confirmed/);
    expect(calls.length).toBe(4);
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });

  it("surfaces terminal 403 as forbidden immediately", async () => {
    const { deps, calls } = makeDeps(() => new Response("denied", { status: 403 }));
    const err = await submitVideo(deps, { query: "x" }).catch((e) => e) as MediaUpstreamError;
    expect(err).toBeInstanceOf(MediaUpstreamError);
    expect(err.kind).toBe("forbidden");
    expect(calls.length).toBe(1);
  });

  it("pure 429 exhaustion answers rate_limit with a no-task-created message", async () => {
    // 429 is a definitive rejection: nothing was accepted upstream, so the
    // error must be a 429-class failure WITHOUT the double-billing warning.
    const { deps, calls } = makeDeps(() => new Response("slow down", { status: 429 }));
    const err = await submitVideo(deps, { query: "x" }).catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("rate_limit");
    expect(err.message).toContain("no task was created");
    expect(err.message).not.toContain("charged");
    expect(calls.length).toBe(4);
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });

  it("an unconfirmed transient (timeout) followed by 429s keeps the double-billing warning", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      if (n === 1) {
        const err = new Error("deadline");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response("slow down", { status: 429 });
    });
    const err = await submitVideo(deps, { query: "x" }).catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("upstream");
    expect(err.message).toContain("may already have been created");
    expect(calls.length).toBe(4);
    expect(new Set(calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
  });
});

describe("queryVideo", () => {
  it("maps succeeded + video_url", async () => {
    const { deps, calls } = makeDeps(() => envelope({ status: "succeeded", output: { video_url: "https://v.test/a.mp4" } }));
    const snap = await queryVideo(deps, "task-1");
    expect(snap.status).toBe("succeeded");
    expect(snap.videoUrl).toBe("https://v.test/a.mp4");
    const body = JSON.parse(calls[0].body as string) as { task_id: string };
    expect(body.task_id).toBe("task-1");
    expect(calls[0].url).toBe("https://zcode.test/api/v1/toolhub/tool/video_generate/tasks/query");
  });

  it("maps failed + failure detail", async () => {
    const { deps } = makeDeps(() => envelope({ status: "failed", failure: { code: "X1", message: "content rejected" } }));
    const snap = await queryVideo(deps, "task-1");
    expect(snap.status).toBe("failed");
    expect(snap.failure).toEqual({ code: "X1", message: "content rejected" });
  });

  it("passes usage through when present", async () => {
    const { deps } = makeDeps(() => envelope({ status: "succeeded", output: { video_url: "https://v.test/b.mp4" }, usage: { completion_tokens: 100, total_tokens: 100 } }));
    const snap = await queryVideo(deps, "task-1");
    expect(snap.usage).toEqual({ completion_tokens: 100, total_tokens: 100 });
  });

  it("throws not_found for terminal 3704", async () => {
    const { deps } = makeDeps(() => envelope({ code: 3704, msg: "task not found" }, 3704));
    const err = await queryVideo(deps, "gone").catch((e) => e) as MediaUpstreamError;
    expect(err.kind).toBe("not_found");
  });

  it("throws when a succeeded task carries no video url", async () => {
    const { deps } = makeDeps(() => envelope({ status: "succeeded", output: {} }));
    await expect(queryVideo(deps, "task-1")).rejects.toThrow(/no video URL/);
  });
});
