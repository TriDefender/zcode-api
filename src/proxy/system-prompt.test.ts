/**
 * Tests for the start-plan system-prompt assembly (ContextBuilder mirror).
 * Golden assertions anchor the byte-exact 3.11.2 bundle shapes:
 * `_reverse/zcode.cjs` `Hre` (assembleSystemMessages), `T9o`
 * (buildEnvInfoSection), `u9o` (identity), `Ylt` (desktop context), `wTr`
 * (dynamic behavior), `STr` (context management), `Vre`/`tct`/`blt`
 * (currentDate context_prefix), `pK` (formatLocalIsoDate).
 */
import { describe, it, expect } from "bun:test";
import {
  buildStartPlanSystem,
  buildContextPrefixMessage,
  buildEnvironmentSection,
  formatLocalIsoDate,
} from "./system-prompt.js";

const ENV = {
  cwd: "/home/dev/project",
  platform: "linux",
  shell: "bash",
  osVersion: "linux 6.8.0-49-generic x64",
};

describe("formatLocalIsoDate (bundle pK)", () => {
  it("formats local YYYY-MM-DD zero-padded", () => {
    expect(formatLocalIsoDate(new Date(2026, 8, 11))).toBe("2026-09-11");
    expect(formatLocalIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("buildEnvironmentSection (bundle T9o)", () => {
  it("emits the heading + invoked line + five value lines joined by \\n", () => {
    expect(buildEnvironmentSection(ENV, "glm-5.3", "zai")).toBe(
      "# Environment\n" +
        "You have been invoked in the following environment:\n" +
        "- Primary working directory: /home/dev/project\n" +
        "- Is a git repository: no\n" +
        "- Platform: linux\n" +
        "- Shell: bash\n" +
        "- OS Version: linux 6.8.0-49-generic x64\n" +
        "- You are powered by the model named zai-api/glm-5.3.",
    );
  });

  it("omits the powered-by line when currentModel is missing/empty/whitespace", () => {
    for (const model of [undefined, "", "   "]) {
      const out = buildEnvironmentSection(ENV, model, "zai");
      expect(out).not.toContain("powered by the model named");
      expect(out.endsWith("- OS Version: linux 6.8.0-49-generic x64")).toBe(true);
    }
  });

  it("prefixes the built-in model-provider id (bundle p2: zai→zai-api, bigmodel→bigmodel-api)", () => {
    expect(buildEnvironmentSection(ENV, "glm-4.6", "bigmodel")).toContain(
      "- You are powered by the model named bigmodel-api/glm-4.6.",
    );
  });

  it("omits the powered-by line when the provider is unknown", () => {
    expect(buildEnvironmentSection(ENV, "glm-5.3")).not.toContain("powered by the model named");
  });

  it("never emits 'unknown' placeholders for cwd/platform/osVersion when given real values", () => {
    const out = buildEnvironmentSection(ENV, "glm-5.3", "zai");
    expect(out).not.toContain(": unknown");
  });
});

describe("buildStartPlanSystem (bundle assembleSystemMessages)", () => {
  it("emits exactly 3 official blocks, each with an ephemeral cache_control breakpoint", () => {
    const blocks = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.type).toBe("text");
      expect(b.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("block 1 is the bare CLI Prefix", () => {
    const [cli] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(cli.text).toBe("You are ZCode, an interactive coding agent");
  });

  it("block 2 = Agent Identity + ZCode Desktop Context, \\n\\n-joined (stable group)", () => {
    const [, stable] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(stable.text.startsWith("\nYou are an interactive ZCode agent that helps users with software engineering tasks.")).toBe(true);
    expect(stable.text).toContain("# Harness");
    // Current 3.7.7+ harness line (mid-conversation system turns)
    expect(stable.text).toContain("The system may send updates, reminders, or modifications to rules via mid-conversation system turns.");
    expect(stable.text).toContain("# ZCode Desktop Context");
    expect(stable.text).toContain("### Files & URLs");
    expect(stable.text).toContain("### Inline Code Comments");
    // Identity section ends with the clickable-reference bullet, then \n\n + desktop
    expect(stable.text).toContain("it's clickable.\n\n# ZCode Desktop Context");
    // Desktop context ends with the ::code-comment example
    expect(stable.text.endsWith('start=10 end=11 priority=2}')).toBe(true);
  });

  it("block 3 = '\\n\\n' + Dynamic Behavior + Environment + Context Management (dynamic group)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(dynamic.text.startsWith("\n\n# Communicating with the user")).toBe(true);
    // Section order: dynamic behavior → environment → context management
    const envIdx = dynamic.text.indexOf("# Environment");
    const cmIdx = dynamic.text.indexOf("# Context management");
    expect(envIdx).toBeGreaterThan(dynamic.text.indexOf("# Communicating with the user"));
    expect(cmIdx).toBeGreaterThan(envIdx);
    // The powered-by line sits mid-block, directly before Context Management
    expect(dynamic.text).toContain("- You are powered by the model named zai-api/glm-5.3.\n\n# Context management");
    // Context management ends with the state-changing-command rule
    expect(dynamic.text.endsWith("A signal that pattern-matches to a known failure may have a different cause.")).toBe(true);
  });

  it("byte-spot: single \\n between the code-style default and the comment rule (wTr join)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(dynamic.text).toContain("match its comment density, naming, and idiom.\nOnly write a code comment");
  });

  it("byte-spot: 'exhaustive survey' has no trailing period (xTr literal)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(dynamic.text).toContain("not an exhaustive survey\n\n");
    expect(dynamic.text).not.toContain("not an exhaustive survey.");
  });

  it("environment lines carry the resolved env values", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai");
    expect(dynamic.text).toContain("- Primary working directory: /home/dev/project");
    expect(dynamic.text).toContain("- Platform: linux");
    expect(dynamic.text).toContain("- Shell: bash");
    expect(dynamic.text).toContain("- OS Version: linux 6.8.0-49-generic x64");
    expect(dynamic.text).toContain("- Is a git repository: no");
  });

  it("appends client system blocks AFTER the official blocks, stripped of cache_control", () => {
    const blocks = buildStartPlanSystem(
      [
        { type: "text", text: "User rule", cache_control: { type: "ephemeral" } },
        { type: "text", text: "" }, // dropped
        "raw string block", // kept
      ],
      "glm-5.3",
      ENV,
      "zai",
    );
    expect(blocks).toHaveLength(5);
    expect(blocks[3]).toEqual({ type: "text", text: "User rule" });
    expect(blocks[4]).toEqual({ type: "text", text: "raw string block" });
  });

  it("returns only the 3 official blocks for absent system", () => {
    expect(buildStartPlanSystem(undefined, undefined, ENV)).toHaveLength(3);
    expect(buildStartPlanSystem(null, undefined, ENV)).toHaveLength(3);
  });
});

describe("buildContextPrefixMessage (bundle tct + Vre + blt)", () => {
  it("emits a user turn wrapping the currentDate section in a system-reminder, exact tct shape", () => {
    const msg = buildContextPrefixMessage(new Date(2026, 8, 11));
    expect(msg.role).toBe("user");
    expect(msg.content).toEqual([
      {
        type: "text",
        text:
          "<system-reminder>" +
          "As you answer the user's questions, you can use the following context:\n" +
          "# currentDate\n" +
          "Today's date is 2026-09-11.\n" +
          "\n" +
          "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task." +
          "</system-reminder>",
      },
    ]);
  });

  it("carries no cache_control (attachments never get breakpoints)", () => {
    const msg = buildContextPrefixMessage(new Date(2026, 8, 11));
    expect(msg.content[0].cache_control).toBeUndefined();
  });
});
