/**
 * Tests for the optional web panel (issue #58): token enforcement, the
 * in-process control dispatch behind `POST /api/control` (no second listener),
 * and the tokenless static routes a browser navigation cannot attach a header
 * to.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_PANEL_HOST,
  DEFAULT_PANEL_PORT,
  PANEL_ENABLED_ENV,
  PANEL_HOST_ENV,
  PANEL_PORT_ENV,
  PANEL_TOKEN_ENV,
  isPanelEnabled,
  resolvePanelSettings,
  startPanelServer,
  type PanelServer,
} from "./panel.js";
import {
  LogBuffer,
  createControlDispatcher,
  type ControlCommand,
  type ControlResponse,
  type ControlState,
} from "../android/control.js";

const TOKEN = "panel-token-for-tests";

/** Same shape the serve entry passes to `startPanelServer`. */
type Dispatcher = (cmd: ControlCommand) => Promise<ControlResponse>;

let panels: PanelServer[] = [];

afterEach(async () => {
  await Promise.all(panels.map((panel) => panel.close().catch(() => {})));
  panels = [];
});

/** Panel bound to a free port; the token is always the test token. */
async function startPanel(
  handleControl: Dispatcher = async () => ({ ok: true, event: "proxyStopped" }),
): Promise<PanelServer> {
  const panel = await startPanelServer({ port: 0, token: TOKEN, handleControl });
  panels.push(panel);
  return panel;
}

function panelUrl(panel: PanelServer, path: string): string {
  return `http://127.0.0.1:${panel.port}${path}`;
}

function controlRequest(panel: PanelServer, init: RequestInit = {}): Promise<Response> {
  return fetch(panelUrl(panel, "/api/control"), {
    method: "POST",
    body: JSON.stringify({ cmd: "status" }),
    ...init,
  });
}

describe("isPanelEnabled", () => {
  it("stays off unless the flag is explicitly truthy", () => {
    expect(isPanelEnabled({})).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "   " })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "0" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "false" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "FALSE" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "no" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "off" })).toBe(false);
  });

  it("accepts the usual truthy spellings, case-insensitively", () => {
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "1" })).toBe(true);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "true" })).toBe(true);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "ON" })).toBe(true);
  });
});

describe("resolvePanelSettings", () => {
  it("returns null while the panel is off, whatever else is set", () => {
    expect(resolvePanelSettings({ [PANEL_TOKEN_ENV]: TOKEN })).toBeNull();
  });

  it("resolves the token, the default port/host, and nothing else", () => {
    // Only `{token, port, host}`: the panel no longer has a control port to
    // forward to, so there is no second listener that could outlive a failed
    // start.
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1", [PANEL_TOKEN_ENV]: ` ${TOKEN} ` })).toEqual({
      token: TOKEN,
      port: DEFAULT_PANEL_PORT,
      host: DEFAULT_PANEL_HOST,
    });
  });

  it("honours an explicit panel port", () => {
    expect(
      resolvePanelSettings({
        [PANEL_ENABLED_ENV]: "true",
        [PANEL_TOKEN_ENV]: TOKEN,
        [PANEL_PORT_ENV]: "9100",
      }),
    ).toEqual({ token: TOKEN, port: 9100, host: DEFAULT_PANEL_HOST });
  });

  it("honours an explicit bind address, falling back to loopback on blanks", () => {
    // The Docker bridge escape hatch: a loopback-bound panel inside the
    // container is unreachable through `-p 8090:8090`.
    expect(
      resolvePanelSettings({
        [PANEL_ENABLED_ENV]: "1",
        [PANEL_TOKEN_ENV]: TOKEN,
        [PANEL_HOST_ENV]: " 0.0.0.0 ",
      }),
    ).toEqual({ token: TOKEN, port: DEFAULT_PANEL_PORT, host: "0.0.0.0" });
    expect(
      resolvePanelSettings({
        [PANEL_ENABLED_ENV]: "1",
        [PANEL_TOKEN_ENV]: TOKEN,
        [PANEL_HOST_ENV]: "   ",
      }),
    ).toEqual({ token: TOKEN, port: DEFAULT_PANEL_PORT, host: DEFAULT_PANEL_HOST });
  });

  it("refuses to start without a token rather than serving an open control plane", () => {
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1" })).toBeNull();
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1", [PANEL_TOKEN_ENV]: "  " })).toBeNull();
  });
});

describe("startPanelServer", () => {
  it("refuses to start without a token", async () => {
    const handleControl: Dispatcher = async () => ({ ok: true, event: "proxyStopped" });
    await expect(startPanelServer({ port: 0, token: "", handleControl })).rejects.toThrow(
      /panel token required/,
    );
    await expect(startPanelServer({ port: 0, token: "  ", handleControl })).rejects.toThrow(
      /panel token required/,
    );
  });

  it("binds loopback on a free port and reports the real one", async () => {
    const panel = await startPanel();
    expect(panel.hostname).toBe("127.0.0.1");
    expect(panel.port).toBeGreaterThan(0);
  });

  it("binds an explicit non-loopback address (Docker bridge wiring)", async () => {
    const handleControl: Dispatcher = async () => ({ ok: true, event: "proxyStopped" });
    const panel = await startPanelServer({ port: 0, hostname: "0.0.0.0", token: TOKEN, handleControl });
    panels.push(panel);
    expect(panel.hostname).toBe("0.0.0.0");
    // 0.0.0.0 covers loopback too, so the tokenless health route stays reachable.
    const health = await fetch(`http://127.0.0.1:${panel.port}/healthz`);
    expect(health.status).toBe(200);
  });

  it("frees the port on close", async () => {
    const panel = await startPanel();
    const port = panel.port;
    await panel.close();
    panels = panels.filter((candidate) => candidate !== panel);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("fails on a taken port without disturbing the panel already there", async () => {
    // Regression for the #58 review's P2: with no control listener in the
    // startup path there is nothing partially started to leak or to clean up.
    const first = await startPanel();
    const handleControl: Dispatcher = async () => ({ ok: true, event: "proxyStopped" });
    await expect(startPanelServer({ port: first.port, token: TOKEN, handleControl })).rejects.toThrow();

    const health = await fetch(panelUrl(first, "/healthz"));
    expect(health.status).toBe(200);
  });
});

describe("panel static routes", () => {
  it("serves the shell and the liveness probe without a token", async () => {
    const panel = await startPanel();

    for (const path of ["/", "/panel"]) {
      const res = await fetch(panelUrl(panel, path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("<title>ZCode Proxy");
      expect(html).toContain("/api/control");
    }

    const health = await fetch(panelUrl(panel, "/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "zcode-panel" });
  });

  it("never fabricates a total for a coding-plan limit", async () => {
    // Regression for the #58 review's P2/P4: upstream `number` is not a
    // comparable total (live TIME_LIMIT row: remaining=3894, number=1), so the
    // window row shows `remaining` alone and only draws a bar when upstream
    // hands us a usable percentage.
    const panel = await startPanel();
    const html = await (await fetch(panelUrl(panel, "/"))).text();
    expect(html).not.toContain("left of");
    expect(html).not.toContain("limit.total");
    expect(html).toContain("remaining");
    expect(html).toContain("limit.percentage");
  });

  it("answers unknown paths with 404 and a non-POST control call with 405", async () => {
    const panel = await startPanel();

    const missing = await fetch(panelUrl(panel, "/nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: "not_found: GET /nope" });

    const wrongMethod = await fetch(panelUrl(panel, "/api/control"));
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ ok: false, error: "method_not_allowed" });
  });
});

describe("panel control authentication", () => {
  it("rejects a missing or wrong token without dispatching anything", async () => {
    let calls = 0;
    const panel = await startPanel(async () => {
      calls++;
      return { ok: true, event: "proxyStopped" };
    });

    const attempts: RequestInit[] = [
      {},
      { headers: { authorization: "Bearer wrong" } },
      { headers: { "x-panel-token": "wrong" } },
      { headers: { authorization: TOKEN } }, // missing the "Bearer " prefix
    ];
    for (const init of attempts) {
      const res = await controlRequest(panel, init);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(calls).toBe(0);
  });

  it("rejects an unauthenticated oversized body as 401, not 413", async () => {
    let calls = 0;
    const panel = await startPanel(async () => {
      calls++;
      return { ok: true, event: "proxyStopped" };
    });

    const res = await controlRequest(panel, { body: "x".repeat(70 * 1024) });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("accepts either header spelling and returns the control envelope", async () => {
    const seen: ControlCommand[] = [];
    const handleControl: Dispatcher = async (cmd) => {
      seen.push(cmd);
      if (cmd.cmd !== "quota") return { ok: true, event: "loggedOut" };
      return { ok: true, event: "quota", quota: { provider: "zai" } as never };
    };
    const panel = await startPanel(handleControl);

    const viaHeader = await controlRequest(panel, {
      headers: { "content-type": "application/json", "x-panel-token": TOKEN },
      body: JSON.stringify({ cmd: "quota" }),
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({ ok: true, event: "quota", quota: { provider: "zai" } });

    const viaBearer = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaBearer.status).toBe(200);

    expect(seen).toEqual([{ cmd: "quota" }, { cmd: "status" }]);
  });

  it("keeps the control protocol's error envelope (200 + ok:false) verbatim", async () => {
    const panel = await startPanel(async (cmd) => ({ ok: false, error: `unknown_cmd: ${cmd.cmd}` }));
    const res = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ cmd: "nope" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "unknown_cmd: nope" });
  });

  it("rejects malformed JSON and non-command payloads before dispatch", async () => {
    let calls = 0;
    const panel = await startPanel(async () => {
      calls++;
      return { ok: true, event: "proxyStopped" };
    });

    const badJson = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "not json",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ ok: false, error: "invalid_json" });

    for (const body of ["null", "[]", '"status"', "{}", '{"cmd":42}']) {
      const res = await controlRequest(panel, { headers: { authorization: `Bearer ${TOKEN}` }, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "invalid_command" });
    }
    expect(calls).toBe(0);
  });

  it("rejects an oversized command body before dispatch", async () => {
    let calls = 0;
    const panel = await startPanel(async () => {
      calls++;
      return { ok: true, event: "proxyStopped" };
    });

    const res = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "request_too_large" });
    expect(calls).toBe(0);
  });

  it("reports a dispatcher crash as internal_error instead of a bare failure", async () => {
    const panel = await startPanel(async () => {
      throw new Error("boom");
    });
    const res = await controlRequest(panel, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "internal_error: boom" });
  });
});

describe("panel ↔ control dispatcher wiring", () => {
  it("runs a real control command in process, with no extra listener", async () => {
    // The full path the panel uses in `serve`: a real dispatcher built from the
    // Android control module, driven over the panel's own authenticated HTTP
    // surface. Nothing here binds a control port.
    let stops = 0;
    const state: ControlState = { provider: "zai", plan: "coding-plan", proxyPort: 8080 };
    const handleControl = createControlDispatcher(state, {
      logBuffer: new LogBuffer(),
      onStopProxy: async () => {
        stops++;
        return { ok: true };
      },
    });
    const panel = await startPanel(handleControl);

    const denied = await controlRequest(panel, {
      body: JSON.stringify({ cmd: "stopProxy" }),
    });
    expect(denied.status).toBe(401);
    expect(stops).toBe(0);

    const allowed = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ cmd: "stopProxy" }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, event: "proxyStopped" });
    expect(stops).toBe(1);
    expect(state.proxyPort).toBe(0);
  });

  it("answers `status` from the same hook state the proxy entry uses", async () => {
    const state: ControlState = { provider: "bigmodel", plan: "start-plan", proxyPort: 0 };
    const handleControl = createControlDispatcher(state, { logBuffer: new LogBuffer() });
    const panel = await startPanel(handleControl);

    const res = await controlRequest(panel, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; provider: string; plan: string; proxyPort: number };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("bigmodel");
    expect(body.plan).toBe("start-plan");
    expect(body.proxyPort).toBe(0);
  });
});
