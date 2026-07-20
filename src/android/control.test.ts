import { describe, it, expect } from "bun:test";
import { Readable } from "node:stream";
import {
  handleControlRequestForTest,
  handleControlRequestWithHooksForTest,
  LogBuffer,
  type ControlState,
  type HandlerContext,
} from "./control.js";

function makeStubRequest(opts: {
  method?: string;
  url?: string;
  body?: string;
  remoteAddress?: string;
}): import("node:http").IncomingMessage {
  const body = opts.body ?? "";
  const stream = Readable.from([Buffer.from(body, "utf-8")]) as unknown as import("node:http").IncomingMessage;
  stream.method = opts.method ?? "POST";
  stream.url = opts.url ?? "/control";
  stream.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
  stream.socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" } as never;
  return stream;
}

async function post(body: unknown, state: ControlState, ctx?: HandlerContext) {
  const req = makeStubRequest({ body: JSON.stringify(body) });
  return ctx
    ? handleControlRequestWithHooksForTest(req, state, ctx)
    : handleControlRequestForTest(req, state);
}

describe("android control listener", () => {
  const baseState: ControlState = {
    provider: "bigmodel",
    plan: "coding-plan",
    proxyPort: 8080,
  };

  it("returns running status for {cmd:status} from loopback", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "127.0.0.1",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "state" in result.body) {
      expect(result.body.state).toBe("running");
      expect(result.body.provider).toBe("bigmodel");
      expect(result.body.plan).toBe("coding-plan");
      expect(result.body.proxyPort).toBe(8080);
    }
  });

  it("rejects non-loopback remoteAddress with HTTP 403", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "192.168.1.5",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(403);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("forbidden");
    }
  });

  it("rejects IPv6 non-loopback (::ffff:8.8.8.8)", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "::ffff:8.8.8.8",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(403);
  });

  it("accepts IPv6 loopback (::1)", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "status" }),
      remoteAddress: "::1",
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
  });

  it("returns 404 for non-/control paths", async () => {
    const req = makeStubRequest({
      url: "/v1/chat/completions",
      body: JSON.stringify({ cmd: "status" }),
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(404);
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = makeStubRequest({ body: "not-json{" });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
  });

  it("returns error for unknown cmd", async () => {
    const req = makeStubRequest({ body: JSON.stringify({ cmd: "bogus" }) });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("unknown_cmd");
    }
  });

  it("returns error for deliverOAuthCode without an active flow", async () => {
    const req = makeStubRequest({
      body: JSON.stringify({ cmd: "deliverOAuthCode", provider: "bigmodel", code: "x", state: "y" }),
    });
    const result = await handleControlRequestForTest(req, baseState);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toContain("no_matching_oauth_flow");
    }
  });
});

describe("android control listener — lifecycle commands", () => {
  const state: ControlState = {
    provider: "bigmodel",
    plan: "coding-plan",
    proxyPort: 0,
  };

  it("startProxy calls hook and updates state.proxyPort", async () => {
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      onStartProxy: async () => ({ ok: true, port: 9999 }),
    };
    const result = await post({ cmd: "startProxy" }, state, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "port" in result.body) {
      expect(result.body.port).toBe(9999);
    }
    expect(state.proxyPort).toBe(9999);
  });

  it("startProxy surfaces hook errors", async () => {
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      onStartProxy: async () => ({ ok: false, error: "not_logged_in" }),
    };
    const result = await post({ cmd: "startProxy" }, state, ctx);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toBe("not_logged_in");
    }
  });

  it("startProxy returns error when hook missing", async () => {
    const result = await post({ cmd: "startProxy" }, state);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toBe("proxy_lifecycle_unavailable");
    }
  });

  it("stopProxy resets state.proxyPort to 0", async () => {
    state.proxyPort = 8080;
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      onStopProxy: async () => ({ ok: true }),
    };
    const result = await post({ cmd: "stopProxy" }, state, ctx);
    expect(result.body.ok).toBe(true);
    expect(state.proxyPort).toBe(0);
  });
});

describe("android control listener — setConfig", () => {
  it("updates provider and plan via hook and syncs state", async () => {
    const state: ControlState = { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 };
    const ctx: HandlerContext = {
      logBuffer: new LogBuffer(),
      onSetConfig: async (changes) => ({
        ok: true,
        provider: changes.provider ?? state.provider,
        plan: changes.plan ?? state.plan,
      }),
    };
    const result = await post({ cmd: "setConfig", provider: "zai", plan: "start-plan" }, state, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "plan" in result.body) {
      expect(result.body.provider).toBe("zai");
      expect(result.body.plan).toBe("start-plan");
    }
    expect(state.provider).toBe("zai");
    expect(state.plan).toBe("start-plan");
  });

  it("returns config_update_unavailable when hook missing", async () => {
    const state: ControlState = { provider: "zai", plan: "coding-plan", proxyPort: 0 };
    const result = await post({ cmd: "setConfig", provider: "bigmodel" }, state);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error).toBe("config_update_unavailable");
    }
  });
});

describe("android control listener — getLogs", () => {
  it("returns all lines when since=0", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("[INFO] line one");
    logBuffer.push("[INFO] line two");
    const ctx: HandlerContext = { logBuffer };
    const result = await post({ cmd: "getLogs" }, { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual(["[INFO] line one", "[INFO] line two"]);
      expect(result.body.nextSince).toBe(2);
    }
  });

  it("returns only lines after `since`", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("a");
    logBuffer.push("b");
    logBuffer.push("c");
    const ctx: HandlerContext = { logBuffer };
    const result = await post({ cmd: "getLogs", since: 1 }, { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual(["b", "c"]);
    }
  });

  it("returns empty when since is at cursor", async () => {
    const logBuffer = new LogBuffer();
    logBuffer.push("only");
    const ctx: HandlerContext = { logBuffer };
    const result = await post({ cmd: "getLogs", since: 1 }, { provider: "bigmodel", plan: "coding-plan", proxyPort: 0 }, ctx);
    expect(result.body.ok).toBe(true);
    if (result.body.ok && "lines" in result.body) {
      expect(result.body.lines).toEqual([]);
    }
  });
});

describe("LogBuffer", () => {
  it("evicts oldest lines past capacity", () => {
    const buf = new LogBuffer(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect([...buf.snapshot()]).toEqual(["b", "c", "d"]);
    expect(buf.cursor).toBe(4);
  });

  it("since() with stale cursor returns all surviving lines", () => {
    const buf = new LogBuffer(2);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    // "a" was evicted; since=0 still returns only surviving lines.
    const result = buf.since(0);
    expect(result.lines).toEqual(["b", "c"]);
    expect(result.nextSince).toBe(3);
  });
});
