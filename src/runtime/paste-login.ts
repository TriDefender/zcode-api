/**
 * Shared plumbing for the headless "paste" login (auth-code flow): the
 * terminal instructions and the readline-with-timeout that collects the
 * pasted callback URL. Pure presentation/IO — the URL parsing and CSRF state
 * check live in `parsePastedCallbackUrl` (auth/oauth.ts).
 *
 * Used by the CLI (`auth login bigmodel --paste`) and the TUI (`L` key),
 * which suspend their own rendering before calling into these.
 */
import { createInterface } from "node:readline";

/** Bold only when attached to a terminal — keeps piped output ANSI-free. */
export function boldIfTTY(text: string): string {
  return process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text;
}

/**
 * Multi-line instructions shown after the flow started, before reading the
 * pasted URL. Printed to the REAL terminal by both entries (the CLI's
 * console is never intercepted; the TUI passes its captured stdout writer).
 * Deliberately loud: the user must understand that the browser "error" page
 * is the expected hand-off, and what the redirected URL looks like.
 */
export function pasteLoginInstructions(
  authorizeUrl: string,
  callbackUrl: string,
  timeoutMs: number,
): string {
  const bar = "=".repeat(72);
  return [
    "",
    bar,
    boldIfTTY("  PASTE LOGIN — the callback page is expected NOT to load"),
    bar,
    "",
    "Open this URL to authorize (any machine with a browser):",
    "",
    `  ${authorizeUrl}`,
    "",
    "After you authorize, the browser redirects to a localhost URL shaped like:",
    "",
    `  (${callbackUrl}?authCode=xxxxxxxx&state=xxxxxxxx)`,
    "",
    "That page will NOT load (connection refused) — that is NORMAL on a",
    "headless machine. Copy the FULL redirected URL from the browser's",
    "address bar, paste it below, and press Enter.",
    `(timeout: ${Math.round(timeoutMs / 1000)}s)`,
    bar,
  ].join("\n");
}

/**
 * Read one line of stdin (the pasted callback URL) with an overall timeout.
 * Callers put the terminal into cooked mode first (the TUI leaves raw mode
 * before this), so the tty line discipline echoes the paste. Rejects with
 * the standard login-timeout message, or when stdin closes without a line
 * (e.g. piped/empty input) so the flow can never hang forever.
 */
export function readPastedLine(
  timeoutMs: number,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error("Authorization timed out. Please retry login.")));
    }, timeoutMs);
    rl.on("line", (line: string) => settle(() => resolve(line)));
    rl.on("close", () => {
      settle(() => reject(new Error("stdin closed before a callback URL was pasted.")));
    });
  });
}
