import { describe, expect, test } from "bun:test";
import { buildFrame, type FrameState } from "./frame.js";
import { displayWidth, stripAnsi } from "./width.js";

function baseState(overrides: Partial<FrameState> = {}): FrameState {
  return {
    version: "2.6.0",
    configPath: "config.yaml",
    provider: "zai",
    plan: "coding-plan",
    authMode: "oauth",
    loggedIn: false,
    apiKeyPreview: "",
    loginInFlight: false,
    loginHint: "",
    serverStatus: "stopped",
    serverUrl: "",
    serverError: "",
    modelCount: 6,
    responsesEnabled: true,
    claimAuto: false,
    logTotal: 0,
    logView: [],
    logFollowing: true,
    logFromBottom: 0,
    toast: null,
    width: 80,
    height: 30,
    ...overrides,
  };
}

function plainLines(state: FrameState): string[] {
  return buildFrame(state).split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
}

describe("buildFrame", () => {
  test("renders the three card titles, mirroring the Android layout", () => {
    const lines = plainLines(baseState());
    const text = lines.join("\n");
    expect(text).toContain("Settings & Login");
    expect(text).toContain("Proxy Server");
    expect(text).toContain("Logs");
  });

  test("shows provider/plan radio state and auth status", () => {
    const text = plainLines(baseState({ loggedIn: true, apiKeyPreview: "ab12cd34…" })).join("\n");
    expect(text).toContain("● zai");
    expect(text).toContain("○ bigmodel");
    expect(text).toContain("● coding-plan");
    expect(text).toContain("○ start-plan");
    expect(text).toContain("logged in · ab12cd34…");
  });

  test("shows a running server with its URL", () => {
    const text = plainLines(
      baseState({ serverStatus: "running", serverUrl: "http://127.0.0.1:8080" }),
    ).join("\n");
    expect(text).toContain("● running");
    expect(text).toContain("http://127.0.0.1:8080");
  });

  test("shows the error row when startup failed", () => {
    const text = plainLines(
      baseState({ serverStatus: "error", serverError: "EADDRINUSE: port busy" }),
    ).join("\n");
    expect(text).toContain("✗ failed");
    expect(text).toContain("EADDRINUSE: port busy");
  });

  test("renders log lines newest-last and marks the count", () => {
    const text = plainLines(
      baseState({
        logTotal: 3,
        logView: [
          { level: "info", text: "one" },
          { level: "error", text: "boom" },
          { level: "info", text: "two" },
        ],
      }),
    ).join("\n");
    expect(text).toContain("(3)");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("boom"));
    expect(text.indexOf("boom")).toBeLessThan(text.indexOf("two"));
  });

  test("shows an empty-log placeholder", () => {
    const text = plainLines(baseState()).join("\n");
    expect(text).toContain("(no logs yet");
  });

  test("scrollback state shows a more-below indicator instead of following", () => {
    const text = plainLines(baseState({ logFollowing: false, logFromBottom: 42 })).join("\n");
    expect(text).toContain("▼ 42 more");
    expect(text).not.toContain("following");
  });

  test("toast line appears above the footer", () => {
    const lines = plainLines(baseState({ toast: { text: "proxy started", kind: "ok" } }));
    const footerIdx = lines.findIndex((l) => l.includes("s start/stop"));
    const toastIdx = lines.findIndex((l) => l.includes("proxy started"));
    expect(toastIdx).toBeGreaterThan(0);
    expect(toastIdx).toBe(footerIdx - 1);
  });

  test("login-in-flight adds a hint row and pill", () => {
    const text = plainLines(
      baseState({ loginInFlight: true, loginHint: "waiting for browser authorization…" }),
    ).join("\n");
    expect(text).toContain("waiting for browser authorization…");
    expect(text).toContain("● logging in…");
  });

  test("apikey mode hides the logged-out warning", () => {
    const text = plainLines(baseState({ authMode: "apikey", loggedIn: false })).join("\n");
    expect(text).toContain("apikey mode (config.yaml)");
    expect(text).not.toContain("not logged in");
  });

  test("provider switch is locked while the proxy runs", () => {
    const text = plainLines(baseState({ serverStatus: "running" })).join("\n");
    expect(text).toContain("(stop to switch)");
  });

  test("no line exceeds the terminal width (CJK logs included)", () => {
    const state = baseState({
      logTotal: 2,
      logView: [
        { level: "info", text: "#001 上游连接失败 upstream connect failed after many retries with backoff" },
        { level: "error", text: "🚀 emoji + 日本語テキスト mixing widths for truncation testing 1234567890" },
      ],
    });
    for (const raw of buildFrame(state).split("\n")) {
      expect(displayWidth(raw)).toBeLessThanOrEqual(state.width);
    }
  });

  test("box borders span the full width", () => {
    const lines = plainLines(baseState());
    const borders = lines.filter((l) => l.startsWith("╭"));
    expect(borders.length).toBe(3);
    for (const b of borders) expect(displayWidth(b)).toBe(80);
    for (const b of lines.filter((l) => l.startsWith("╰"))) {
      expect(displayWidth(b)).toBe(80);
    }
  });

  test("fills the terminal height: cards + logs + footer", () => {
    const state = baseState({
      logTotal: 50,
      logView: Array.from({ length: 50 }, (_, i) => ({ level: "info", text: `log ${i}` })),
    });
    const lines = plainLines(state);
    // every rendered row (before \x1b[J) accounts for one terminal row
    expect(lines.length).toBe(30);
  });

  test("too-small terminals get a compact message instead of boxes", () => {
    const frame = buildFrame(baseState({ width: 30, height: 10 }));
    expect(frame).toContain("terminal too small");
    expect(frame).not.toContain("╭");
  });
});
