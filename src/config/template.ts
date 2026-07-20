/**
 * Bundled config template — loaded via `readFileSync` so the same code runs on
 * Bun (source mode) and Node (esbuild CJS bundle for Android).
 *
 * Source of truth: config.example.yaml at repo root. The bundler (Bun
 * `--compile` for desktop, esbuild for Android) keeps the .yaml file alongside
 * the emitted JS so the runtime path resolves correctly.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __dirname: string | undefined;

const MODULE_DIR = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

// Two layouts: Android bundle (asset is sibling of server.cjs) and desktop
// source mode (asset is at repo root, two levels up from src/config/).
const TEMPLATE_PATH = [
  join(MODULE_DIR, "config.example.yaml"),
  join(MODULE_DIR, "..", "..", "config.example.yaml"),
].find(existsSync);

if (!TEMPLATE_PATH) {
  throw new Error(`config.example.yaml not found alongside ${MODULE_DIR} or two levels up`);
}

export const EXAMPLE_CONFIG_YAML: string = readFileSync(TEMPLATE_PATH, "utf-8");
