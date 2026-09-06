/**
 * Tests for the shared paste-login IO helpers (headless bigmodel login).
 * The URL parsing / CSRF state check lives in auth/oauth.test.ts; this file
 * covers the terminal instructions and the readline-with-timeout.
 *
 * @see src/runtime/paste-login.ts
 */
import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { pasteLoginInstructions, readPastedLine } from "./paste-login.js";

describe("readPastedLine", () => {
  it("resolves with the first completed line", async () => {
    const input = new PassThrough();
    const pending = readPastedLine(1_000, input);
    input.write("http://127.0.0.1:9/cb?code=x&state=y\r\n");
    expect(await pending).toBe("http://127.0.0.1:9/cb?code=x&state=y");
  });

  it("rejects with the login-timeout message when no line arrives", async () => {
    const input = new PassThrough();
    await expect(readPastedLine(20, input)).rejects.toThrow(/timed out/);
    input.end();
  });

  it("rejects when the input closes before a line arrives", async () => {
    const input = new PassThrough();
    const pending = readPastedLine(1_000, input);
    input.end();
    await expect(pending).rejects.toThrow(/stdin closed/);
  });
});

describe("pasteLoginInstructions", () => {
  it("shows the authorize URL and the bracketed redirected-URL example with the real port", () => {
    const text = pasteLoginInstructions(
      "https://auth.example/login?appId=zcode",
      "http://127.0.0.1:41235/oauth/callback/bigmodel",
      300_000,
    );
    expect(text).toContain("https://auth.example/login?appId=zcode");
    expect(text).toContain(
      "(http://127.0.0.1:41235/oauth/callback/bigmodel?authCode=xxxxxxxx&state=xxxxxxxx)",
    );
    expect(text).toContain("timeout: 300s");
  });
});
