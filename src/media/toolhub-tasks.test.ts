/**
 * ToolHub task faces (happyhorse + the 3D family) tests: parser contracts
 * pinned against the official plugin sources (see toolhub-tasks.ts header —
 * `_reverse/plugins-3.19.1/`), the same-key ladder on the generic submitter,
 * and the vendor-config wiring (tool names / caps / material fields).
 */
import { describe, it, expect } from "bun:test";
import {
  buildHappyhorseBody,
  createHappyhorseVideo,
  createModel3dTask,
  getHappyhorseVideo,
  getModel3dTask,
  isModel3dVendor,
  MODEL3D_VENDORS,
  parseHappyhorseSubmit,
  prepareModel3dBody,
} from "./toolhub-tasks.js";
import { submitToolhubTask, type ToolHubDeps } from "./toolhub.js";

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
const submitOk = (taskId: string) => envelope({ state: "SUCCEEDED", output: { task_id: taskId }, invocation_id: "inv-1" });

// ── parseHappyhorseSubmit (pure) ────────────────────────────────────────────

describe("parseHappyhorseSubmit", () => {
  it("accepts the minimal prompt-only body", () => {
    const parsed = parseHappyhorseSubmit({ prompt: "a horse running" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.req).toEqual({ prompt: "a horse running" });
  });

  it("accepts duration 3..15 and normalizes resolution casing", () => {
    const parsed = parseHappyhorseSubmit({ prompt: "x", duration: 5, resolution: "720p", ratio: "9:16" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.req.duration).toBe(5);
      expect(parsed.req.resolution).toBe("720P");
      expect(parsed.req.ratio).toBe("9:16");
    }
  });

  it("treats an empty duration string as omitted (plugin durationArg default)", () => {
    const parsed = parseHappyhorseSubmit({ prompt: "x", duration: "" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect("duration" in parsed.req).toBe(false);
  });

  it("accepts underscore request_ids and rejects unsafe shapes with 400 material", () => {
    expect(parseHappyhorseSubmit({ prompt: "x", request_id: "req_1" }).ok).toBe(true);
    const bad = parseHappyhorseSubmit({ prompt: "x", request_id: "has space" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("request_id");
  });

  // 等价类参数化循环：falsy/越界 duration 全拒（falsy duration=省略=合法，单列）。
  for (const bad of [2, 16, 3.5, "abc"]) {
    it(`rejects duration ${JSON.stringify(bad)}`, () => {
      const parsed = parseHappyhorseSubmit({ prompt: "x", duration: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("duration");
    });
  }

  it("rejects out-of-enum resolution and ratio", () => {
    expect(parseHappyhorseSubmit({ prompt: "x", resolution: "4K" }).ok).toBe(false);
    expect(parseHappyhorseSubmit({ prompt: "x", ratio: "16:10" }).ok).toBe(false);
  });

  it("rejects first_frame combined with reference_images (plugin mutual exclusion)", () => {
    const parsed = parseHappyhorseSubmit({
      prompt: "x",
      first_frame: "https://a.test/f.png",
      reference_images: ["https://a.test/r.png"],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("mutually exclusive");
  });

  it("rejects more than 9 reference images", () => {
    const parsed = parseHappyhorseSubmit({ prompt: "x", reference_images: Array.from({ length: 10 }, (_, i) => `https://a.test/${i}.png`) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("at most 9");
  });

  it("rejects data: and non-https materials (plugin contract: https-only)", () => {
    const data = parseHappyhorseSubmit({ prompt: "x", first_frame: "data:image/png;base64,AAAA" });
    expect(data.ok).toBe(false);
    if (!data.ok) expect(data.message).toContain("data:");
    const http = parseHappyhorseSubmit({ prompt: "x", first_frame: "http://a.test/f.png" });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.message).toContain("https");
  });

  it("rejects credentialed image URLs", () => {
    const parsed = parseHappyhorseSubmit({ prompt: "x", first_frame: "https://user:pw@a.test/f.png" });
    expect(parsed.ok).toBe(false);
  });

  it("buildHappyhorseBody maps fields onto the plugin wire names", () => {
    const body = buildHappyhorseBody({
      prompt: "p",
      duration: 7,
      resolution: "1080P",
      ratio: "1:1",
      firstFrame: "https://a.test/f.png",
    });
    expect(body).toEqual({
      prompt: "p",
      duration: 7,
      resolution: "1080P",
      ratio: "1:1",
      image_url_list: ["https://a.test/f.png"],
    });
    expect("reference_image_url_list" in body).toBe(false);
  });
});

// ── prepareModel3dBody / vendor config ──────────────────────────────────────

describe("prepareModel3dBody", () => {
  it("validates action against the vendor enum and forwards unknown fields verbatim", async () => {
    const { deps } = makeDeps(() => envelope({}));
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.hyper3d, {
      action: "generate",
      prompt: "a sword",
      quality: "high",
      format: "glb",
    });
    expect(body).toEqual({ action: "generate", prompt: "a sword", quality: "high", format: "glb" });
    await expect(
      prepareModel3dBody(deps, MODEL3D_VENDORS.hi3d, { action: "rig" }),
    ).rejects.toThrow(/action must be one of/);
  });

  it("rejects a missing action", async () => {
    const { deps } = makeDeps(() => envelope({}));
    await expect(prepareModel3dBody(deps, MODEL3D_VENDORS.meshy, {})).rejects.toThrow(/action is required/);
  });

  it("passes https images through untouched", async () => {
    const { deps, calls } = makeDeps(() => envelope({}));
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.meshy, {
      action: "generate",
      images: ["https://a.test/1.png", "https://a.test/2.png"],
    });
    expect(body.images).toEqual(["https://a.test/1.png", "https://a.test/2.png"]);
    expect(calls.length).toBe(0); // no upload for https material
  });

  it("caps images per vendor (meshy 4)", async () => {
    const { deps } = makeDeps(() => envelope({}));
    await expect(
      prepareModel3dBody(deps, MODEL3D_VENDORS.meshy, {
        action: "generate",
        images: ["1", "2", "3", "4", "5"].map((n) => `https://a.test/${n}.png`),
      }),
    ).rejects.toThrow(/at most 4/);
  });

  it("uploads data: images to /toolhub/files and swaps in the presigned url", async () => {
    const { deps, calls } = makeDeps((call) => {
      if (call.url.endsWith("/api/v1/toolhub/files")) {
        return envelope({ url: "https://presigned.test/u.png" });
      }
      return envelope({});
    });
    // 1x1 png
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.hyper3d, {
      action: "generate",
      images: ["data:image/png;base64,iVBORw0KGgo="],
    });
    expect(body.images).toEqual(["https://presigned.test/u.png"]);
    expect(calls[0].url).toBe("https://zcode.test/api/v1/toolhub/files");
    // data: URL must NOT reach the invoke body (负向抑制).
    expect(JSON.stringify(body)).not.toContain("data:image");
  });

  it("rejects malformed base64 (URL-safe alphabet / broken padding)", async () => {
    const { deps } = makeDeps(() => envelope({}));
    for (const bad of ["data:image/png;base64,AA-A", "data:image/png;base64,A", "data:image/png;base64,AAA=AA"]) {
      await expect(
        prepareModel3dBody(deps, MODEL3D_VENDORS.hi3d, { action: "generate", images: [bad] }),
      ).rejects.toThrow(/base64/);
    }
  });

  it("rejects non-png/jpeg/webp data: mimes and oversized decoded images", async () => {
    const { deps } = makeDeps(() => envelope({}));
    await expect(
      prepareModel3dBody(deps, MODEL3D_VENDORS.hi3d, { action: "generate", images: ["data:image/gif;base64,AAAA"] }),
    ).rejects.toThrow(/png \/ jpeg \/ webp/);
    // 11 MiB of zeros > hyper3d's 10 MiB cap.
    const big = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    await expect(
      prepareModel3dBody(deps, MODEL3D_VENDORS.hyper3d, { action: "generate", images: [`data:image/png;base64,${big}`] }),
    ).rejects.toThrow(/MiB image cap/);
  });

  it("resolves the vendor's singular image field (meshy texture_image)", async () => {
    const { deps } = makeDeps((call) => {
      if (call.url.endsWith("/api/v1/toolhub/files")) return envelope({ url: "https://presigned.test/t.png" });
      return envelope({});
    });
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.meshy, {
      action: "retexture",
      model_url: "https://a.test/m.glb",
      texture_image: "data:image/jpeg;base64,AAAA",
      texture_prompt: "brushed steel",
    });
    expect(body.texture_image).toBe("https://presigned.test/t.png");
    expect(body.model_url).toBe("https://a.test/m.glb");
  });

  it("resolves hi3d's texture `image` field (data: → upload, mirrors prepareImage)", async () => {
    const { deps, calls } = makeDeps((call) => {
      if (call.url.endsWith("/api/v1/toolhub/files")) return envelope({ url: "https://presigned.test/i.png" });
      return envelope({});
    });
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.hi3d, {
      action: "texture",
      model_url: "https://a.test/m.glb",
      image: "data:image/png;base64,AAAA",
    });
    expect(body.image).toBe("https://presigned.test/i.png");
    expect(calls.length).toBe(1);
  });

  it("rejects non-string singular image fields instead of silently dropping them", async () => {
    const { deps } = makeDeps(() => envelope({}));
    await expect(
      prepareModel3dBody(deps, MODEL3D_VENDORS.meshy, { action: "retexture", texture_image: 42 }),
    ).rejects.toThrow(/texture_image must be a non-empty string/);
  });

  it("accepts image/jpg as image/jpeg (plugin alias) and long presigned https URLs", async () => {
    const { deps } = makeDeps((call) => {
      if (call.url.endsWith("/api/v1/toolhub/files")) return envelope({ url: "https://presigned.test/j.jpg" });
      return envelope({});
    });
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.hyper3d, {
      action: "generate",
      image: "data:image/jpg;base64,AAAA",
    });
    expect(body.image).toBe("https://presigned.test/j.jpg");
    // MAX_URL_CHARS is a happyhorse-only constant — 3D https refs have no cap.
    const long = "https://a.test/" + "a".repeat(3000) + ".png";
    const noCap = await prepareModel3dBody(deps, MODEL3D_VENDORS.hi3d, { action: "generate", images: [long] });
    expect(noCap.images).toEqual([long]);
  });

  it("strips request_id from the forwarded body", async () => {
    const { deps } = makeDeps(() => envelope({}));
    const body = await prepareModel3dBody(deps, MODEL3D_VENDORS.hyper3d, { action: "generate", prompt: "x", request_id: "req-123" });
    expect("request_id" in body).toBe(false);
  });
});

// ── generic submitter + faces ───────────────────────────────────────────────

describe("submitToolhubTask / task faces", () => {
  it("targets the vendor tool path and honors request_id as the Idempotency-Key", async () => {
    const { deps, calls } = makeDeps(() => submitOk("task-1"));
    const result = await submitToolhubTask(deps, "happyhorse_video", { prompt: "x" }, "req-abc-1");
    expect(result.taskId).toBe("task-1");
    expect(calls[0].url).toBe("https://zcode.test/api/v1/toolhub/tool/happyhorse_video/invoke");
    expect(calls[0].headers["idempotency-key"]).toBe("req-abc-1");
  });

  it("fails loudly on invalid request_id shapes (never silently re-keys)", async () => {
    const { deps, calls } = makeDeps(() => submitOk("task-1"));
    // Header-unsafe shapes (whitespace / control chars) must not be honored…
    for (const bad of ["has space", "req\nX:1", ""]) {
      await expect(submitToolhubTask(deps, "hyper3d_model3d", { action: "generate" }, bad)).rejects.toThrow(
        /request_id must be 1-128 printable ASCII/,
      );
    }
    expect(calls.length).toBe(0);
    // …while an underscore id (legal header value) IS honored — plugin
    // contract `key = requestId || randomUUID()` accepts any string.
    const { deps: ok } = makeDeps(() => submitOk("task-2"));
    const result = await submitToolhubTask(ok, "hyper3d_model3d", { action: "generate" }, "req_1");
    expect(result.taskId).toBe("task-2");
  });

  it("sends X-Usage-Scenario with the plugin's billing scenario name", async () => {
    const hh = makeDeps(() => submitOk("t"));
    await createHappyhorseVideo(hh.deps, { prompt: "x" });
    // happyhorse's scenario is the hyphenated PLUGIN name, not the tool name.
    expect(hh.calls[0].headers["x-usage-scenario"]).toBe("happyhorse-video");
    const m3d = makeDeps(() => submitOk("t"));
    await createModel3dTask(m3d.deps, "meshy", { action: "generate", prompt: "x" });
    expect(m3d.calls[0].headers["x-usage-scenario"]).toBe("meshy_model3d");
  });

  it("retries UNKNOWN with the SAME key until SUCCEEDED", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(() => {
      n += 1;
      return n < 3 ? envelope({ state: "UNKNOWN" }) : submitOk("task-9");
    });
    const result = await submitToolhubTask(deps, "meshy_model3d", { action: "generate" });
    expect(result.taskId).toBe("task-9");
    expect(calls.length).toBe(3);
    const keys = new Set(calls.map((c) => c.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
  });

  it("createHappyhorseVideo / getHappyhorseVideo round the wire", async () => {
    let state: "submit" | "running" | "done" = "submit";
    const { deps } = makeDeps((call) => {
      if (call.url.endsWith("/invoke")) {
        state = "running";
        return submitOk("hh-1");
      }
      if (state === "running") {
        state = "done";
        return envelope({ status: "running" });
      }
      return envelope({ status: "succeeded", output: { video_url: "https://v.test/h.mp4" } });
    });
    const created = await createHappyhorseVideo(deps, { prompt: "p" });
    expect(created).toEqual({ task_id: "hh-1", status: "queued" });
    const running = await getHappyhorseVideo(deps, "hh-1");
    expect(running.status).toBe("running");
    expect("video_url" in running).toBe(false);
    const done = await getHappyhorseVideo(deps, "hh-1");
    expect(done).toEqual({ task_id: "hh-1", status: "succeeded", video_url: "https://v.test/h.mp4" });
  });

  it("getHappyhorseVideo surfaces failure codes", async () => {
    const { deps } = makeDeps(() => envelope({ status: "failed", failure: { code: "CONTENT_REVIEW", message: "rejected" } }));
    const failed = await getHappyhorseVideo(deps, "hh-x");
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({ code: "CONTENT_REVIEW", message: "rejected" });
  });

  it("createModel3dTask queries the right vendor tool; getModel3dTask maps files[]", async () => {
    const { deps, calls } = makeDeps((call) => {
      if (call.url.endsWith("/invoke")) return submitOk("gen:uuid~sub");
      return envelope({
        status: "succeeded",
        output: { files: [{ name: "model.glb", url: "https://d.test/model.glb" }, { name: "", url: "" }, "junk" ] },
      });
    });
    const created = await createModel3dTask(deps, "hyper3d", { action: "generate", prompt: "x" });
    expect(created.task_id).toBe("gen:uuid~sub");
    expect(calls[0].url).toBe("https://zcode.test/api/v1/toolhub/tool/hyper3d_model3d/invoke");
    const done = await getModel3dTask(deps, "hyper3d", "gen:uuid~sub");
    // Entries without a usable url are dropped (completedProducts mirror).
    expect(done.files).toEqual([{ name: "model.glb", url: "https://d.test/model.glb" }]);
  });

  it("getModel3dTask maps per-vendor success shapes (meshy model_urls/result, hi3d url/cover_url)", async () => {
    // meshy: model_urls map + nested result URLs; thumbnail excluded by plugin contract.
    const meshy = makeDeps(() =>
      envelope({
        status: "succeeded",
        output: {
          model_urls: { glb: "https://d.test/m.glb", fbx: "" },
          result: { variants: [{ url: "https://d.test/v1.glb" }, { url: "not-a-url" }] },
          thumbnail_url: "https://d.test/thumb.png",
        },
      }),
    );
    const meshyDone = await getModel3dTask(meshy.deps, "meshy", "t");
    expect(meshyDone.status).toBe("succeeded");
    expect(meshyDone.files).toEqual([
      { name: "glb", url: "https://d.test/m.glb" },
      { name: "result.variants[0].url", url: "https://d.test/v1.glb" },
    ]);

    // hi3d: output.url model + optional cover_url.
    const hi3d = makeDeps(() => envelope({ status: "succeeded", output: { url: "https://d.test/h.glb", cover_url: "https://d.test/c.png" } }));
    expect((await getModel3dTask(hi3d.deps, "hi3d", "t")).files).toEqual([
      { name: "model", url: "https://d.test/h.glb" },
      { name: "cover", url: "https://d.test/c.png" },
    ]);

    // hyper3d: top-level data.files fallback (plugin completedProducts tolerance).
    const h3d = makeDeps(() => envelope({ status: "succeeded", files: [{ name: "m.glb", url: "https://d.test/m.glb" }] }));
    expect((await getModel3dTask(h3d.deps, "hyper3d", "t")).files).toEqual([{ name: "m.glb", url: "https://d.test/m.glb" }]);
  });

  it("getModel3dTask keeps polling when succeeded carries no products yet (plugin contract)", async () => {
    const { deps } = makeDeps(() => envelope({ status: "succeeded", output: {} }));
    const result = await getModel3dTask(deps, "hi3d", "t");
    expect(result).toEqual({ task_id: "t", status: "running" });
  });

  it("isModel3dVendor + vendor tool names are the ToolHub {vendor}_{category} shape", () => {
    expect(isModel3dVendor("hyper3d")).toBe(true);
    expect(isModel3dVendor("tripo")).toBe(false); // 族外 http 直连，不在本面
    expect(MODEL3D_VENDORS.meshy.tool).toBe("meshy_model3d");
    expect(MODEL3D_VENDORS.hi3d.tool).toBe("hi3d_model3d");
  });
});
