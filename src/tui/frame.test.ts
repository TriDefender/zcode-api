import { describe, expect, test } from "bun:test";
import { buildFrame, findRegion, type FrameState } from "./frame.js";
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
  return buildFrame(state).text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
}

describe("buildFrame", () => {
  test("renders the three card titles, mirroring the Android layout", () => {
    const lines = plainLines(baseState());
    const text = lines.join("\n");
    expect(text).toContain("Settings & Login");
    expect(text).toContain("Proxy Server");
    expect(text).toContain("Logs");
  });

  test("shows provider/plan button state and auth status", () => {
    const text = plainLines(baseState({ loggedIn: true, apiKeyPreview: "ab12cd34…" })).join("\n");
    expect(text).toContain(" zai ");
    expect(text).toContain(" bigmodel ");
    expect(text).toContain(" coding-plan ");
    expect(text).toContain(" start-plan ");
    expect(text).toContain("logged in · ab12cd34…");
    expect(text).toContain(" Logged In ");
    expect(text).toContain(" Logout ");
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
    const footerIdx = lines.findIndex((l) => l.includes("[s] start/stop"));
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

  test("server Start/Stop are clickable in either state (filled buttons row)", () => {
    for (const serverStatus of ["stopped", "running"] as const) {
      const f = buildFrame(baseState({ serverStatus, loggedIn: true, apiKeyPreview: "ab…" }));
      const lines = f.text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const serverRow = lines.findIndex((l) => l.includes(" Stop ") && !l.includes("[s]"));
      expect(serverRow).toBeGreaterThan(0);
      const onRow = f.regions.filter((r) => r.row === serverRow);
      expect(onRow.some((r) => r.action.kind === "key" && r.action.key === "s")).toBe(true);
      const text = lines.join("\n");
      expect(text).toContain(" Start ");
      expect(text).toContain(" Stop ");
    }
  });

  test("registers click regions for provider/plan/login/server/footer buttons", () => {
    const { regions } = buildFrame(baseState());
    const actions = regions.map((r) => r.action);
    expect(actions).toContainEqual({ kind: "provider", value: "zai" });
    expect(actions).toContainEqual({ kind: "provider", value: "bigmodel" });
    expect(actions).toContainEqual({ kind: "plan", value: "coding-plan" });
    expect(actions).toContainEqual({ kind: "plan", value: "start-plan" });
    expect(actions).toContainEqual({ kind: "key", key: "l" });
    expect(actions).toContainEqual({ kind: "key", key: "s" });
    expect(actions).toContainEqual({ kind: "key", key: "q" });
  });

  test("findRegion hit-tests provider buttons on their row", () => {
    const { text, regions } = buildFrame(baseState());
    const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
    const providerRow = lines.findIndex((l) => l.includes(" zai "));
    expect(providerRow).toBeGreaterThan(0);
    const colOfZai = lines[providerRow]!.indexOf(" zai ");
    const colOfBigmodel = lines[providerRow]!.indexOf(" bigmodel ");
    expect(findRegion(regions, providerRow, colOfZai + 2)).toEqual({ kind: "provider", value: "zai" });
    expect(findRegion(regions, providerRow, colOfBigmodel + 2)).toEqual({ kind: "provider", value: "bigmodel" });
    expect(findRegion(regions, providerRow, colOfBigmodel - 1)).toBeNull();
  });

  test("provider/plan buttons are locked (no regions) while the proxy runs", () => {
    const { regions } = buildFrame(baseState({ serverStatus: "running" }));
    const providerRegions = regions.filter((r) => r.action.kind === "provider");
    expect(providerRegions).toEqual([]);
  });

  test("logout is only clickable when logged in (card button, not footer)", () => {
    const cardLogoutRegions = (f: { text: string; regions: ReturnType<typeof buildFrame>["regions"] }) => {
      const lines = f.text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" Logout "));
      return f.regions.filter((r) => r.row === row && r.action.kind === "key" && r.action.key === "o");
    };
    expect(cardLogoutRegions(buildFrame(baseState({ loggedIn: false })))).toEqual([]);
    expect(cardLogoutRegions(buildFrame(baseState({ loggedIn: true, apiKeyPreview: "ab12…" })))).toHaveLength(1);
  });

  test("the log title bar is a follow button while scrolled", () => {
    const following = buildFrame(baseState({ logFollowing: true }));
    expect(following.regions.some((r) => r.action.kind === "follow")).toBe(false);
    const scrolled = buildFrame(baseState({ logFollowing: false, logFromBottom: 9 }));
    const follow = scrolled.regions.find((r) => r.action.kind === "follow");
    expect(follow).toBeDefined();
    expect(follow!.row).toBeGreaterThan(0);
  });

  test("buttons keep their slots when the selection changes (no jumping)", () => {
    // zai is always the first slot, bigmodel the second — regardless of which
    // is selected (the user's mouse must not hit a different button twice).
    for (const provider of ["zai", "bigmodel"] as const) {
      const { text, regions } = buildFrame(baseState({ provider }));
      const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" zai "));
      expect(lines[row]!.indexOf(" zai ")).toBeLessThan(lines[row]!.indexOf(" bigmodel "));
      const bigmodelCol = lines[row]!.indexOf(" bigmodel ");
      expect(findRegion(regions, row, bigmodelCol + 2)).toEqual({ kind: "provider", value: "bigmodel" });
      expect(findRegion(regions, row, lines[row]!.indexOf(" zai ") + 2)).toEqual({ kind: "provider", value: "zai" });
    }
    for (const plan of ["coding-plan", "start-plan"] as const) {
      const { text } = buildFrame(baseState({ plan }));
      const lines = text.split("\n").map((l) => stripAnsi(l.replace(/\x1b\[K$/, "")));
      const row = lines.findIndex((l) => l.includes(" coding-plan "));
      expect(lines[row]!.indexOf(" coding-plan ")).toBeLessThan(lines[row]!.indexOf(" start-plan "));
    }
  });

  test("no line exceeds the terminal width (CJK logs included)", () => {
    const state = baseState({
      logTotal: 2,
      logView: [
        { level: "info", text: "#001 上游连接失败 upstream connect failed after many retries with backoff" },
        { level: "error", text: "🚀 emoji + 日本語テキスト mixing widths for truncation testing 1234567890" },
      ],
    });
    for (const raw of buildFrame(state).text.split("\n")) {
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
    const frame = buildFrame(baseState({ width: 30, height: 10 })).text;
    expect(frame).toContain("terminal too small");
    expect(frame).not.toContain("╭");
  });
});
