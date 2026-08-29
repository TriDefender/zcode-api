import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConfigYaml } from "./edit.js";

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
});
