/**
 * Targeted YAML config editing helpers shared by the CLI entries (serve /
 * android / tui) and the TUI runtime.
 */
import { parse, stringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
import type { ProviderId } from "../provider/types.js";

/** Targeted YAML update of top-level `provider` and `plan` keys. */
export function updateConfigYaml(
  path: string,
  fields: { provider: ProviderId; plan: "coding-plan" | "start-plan" },
): void {
  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw) ?? {};
  parsed.provider = fields.provider;
  parsed.plan = fields.plan;
  writeFileSync(path, stringify(parsed), "utf-8");
}
