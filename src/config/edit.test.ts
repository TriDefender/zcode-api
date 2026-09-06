import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConfigYaml, ensureConfigFile } from "./edit.js";

describe("updateConfigYaml", () => {
  test("rewrites top-level provider and plan, preserving other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-tui-test-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 8080",
        "provider: zai",
        "plan: coding-plan",
        "models:",
        "  - glm-4.6",
        "  - glm-5.3",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      updateConfigYaml(path, { provider: "bigmodel", plan: "start-plan" });
      const updated = readFileSync(path, "utf-8");
      expect(updated).toContain("provider: bigmodel");
      expect(updated).toContain("plan: start-plan");
      expect(updated).toContain("port: 8080");
      expect(updated).toContain("- glm-5.3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves YAML comments through the edit (parseDocument round-trip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-edit-comments-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      [
        "# zcode-proxy configuration",
        "server:",
        "  host: 127.0.0.1   # loopback only",
        "  port: 8080",
        "",
        "# Which plan tier to use:",
        "plan: coding-plan",
        "provider: zai",
        "",
        "# models are informational",
        "models:",
        "  - glm-4.6",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      updateConfigYaml(path, { provider: "zai", plan: "start-plan" });
      const updated = readFileSync(path, "utf-8");
      // The edit must keep the annotated template usable — comments are the
      // only documentation users see in this file.
      expect(updated).toContain("# zcode-proxy configuration");
      expect(updated).toContain("# loopback only");
      expect(updated).toContain("# Which plan tier to use:");
      expect(updated).toContain("# models are informational");
      expect(updated).toContain("plan: start-plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureConfigFile", () => {
  test("creates the file from the bundled template once, then is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-ensure-config-"));
    const path = join(dir, "config.yaml");
    try {
      expect(ensureConfigFile(path)).toBe(true);
      const created = readFileSync(path, "utf-8");
      expect(created).toContain("plan: coding-plan");
      // Second call: already exists → no rewrite (returns false, content kept)
      const before = readFileSync(path, "utf-8");
      expect(ensureConfigFile(path)).toBe(false);
      expect(readFileSync(path, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
