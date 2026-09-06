/**
 * Targeted YAML config editing helpers shared by the CLI entries (serve /
 * android / tui) and the TUI runtime.
 */
import { parseDocument } from "yaml";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { ProviderId } from "../provider/types.js";
import { EXAMPLE_CONFIG_YAML } from "./template.js";

/**
 * Targeted YAML update of top-level `provider` and `plan` keys.
 *
 * Uses `yaml`'s document model (`parseDocument` → `set` → `String(doc)`) so
 * comments and formatting in the rest of the file survive the edit — the old
 * `parse`/`stringify` round-trip dropped every comment, and this file is what
 * users see (and edit) in config.yaml.
 */
export function updateConfigYaml(
  path: string,
  fields: { provider: ProviderId; plan: "coding-plan" | "start-plan" },
): void {
  const doc = parseDocument(readFileSync(path, "utf-8"));
  doc.set("provider", fields.provider);
  doc.set("plan", fields.plan);
  writeFileSync(path, String(doc), "utf-8");
}

/**
 * Create the config file from the bundled template when missing.
 * Shared by the CLI entries (serve / android / auth login) and the TUI —
 * they used to each hand-roll this block. Returns true when the file was
 * created, false when it already existed.
 */
export function ensureConfigFile(path: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
  return true;
}
