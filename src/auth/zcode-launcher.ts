/**
 * Launch ZCode briefly so the host process provisions Start Plan balance buckets.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_PATHS = ["/opt/ZCode/zcode", "/usr/bin/zcode"];

export function resolveZcodeBinary(): string {
  const fromEnv = process.env.ZCODE_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of DEFAULT_PATHS) {
    if (existsSync(p)) return p;
  }
  try {
    return execSync("which zcode", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("ZCode binary not found. Set ZCODE_BIN=/path/to/zcode");
  }
}

/** Start ZCode detached (GUI). Returns child pid when available. */
export function launchZcode(): number | undefined {
  const bin = resolveZcodeBinary();
  const child = spawn(bin, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? undefined;
}

/** Best-effort shutdown of ZCode processes started for onboarding. */
export function stopZcode(): void {
  const patterns = ["/opt/ZCode/zcode", "ZCode/zcode"];
  for (const pattern of patterns) {
    try {
      execSync(`pkill -f "${pattern}"`, { stdio: "ignore" });
    } catch {
      // no matching process
    }
  }
}
