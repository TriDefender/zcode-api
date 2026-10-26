/**
 * Tests for the start-plan system-prompt assembly (ContextBuilder mirror).
 * Golden assertions anchor the byte-exact 3.16.3 bundle shapes:
 * `_reverse/glm/zcode.cjs` `Fje` (ContextBuilder/assembleSystemMessages),
 * `Eua` (buildEnvInfoContent), `$Oi`-family (identity), `Ekn` (desktop
 * context incl. Interactive views), `N0o` (dynamic behavior), `F0o`
 * (context management), `Mje`/`Rkn` (currentDate context_prefix), `pK`
 * (formatLocalIsoDate). Block shape per 3.15.1+ wire: cli_prefix block has
 * NO cache_control (`_reverse/NOTEPAD.md` "3.16.3 增补" §F).
 */
import { describe, it, expect } from "bun:test";
import {
  buildStartPlanSystem,
  buildContextPrefixMessage,
  buildDesktopContextSection,
  buildEnvironmentSection,
  formatLocalIsoDate,
} from "./system-prompt.js";

const ENV = {
  cwd: "/home/dev/project",
  platform: "linux",
  shell: "bash",
  osVersion: "linux 6.8.0-49-generic x64",
};

const VIZ_DIR = "/home/dev/.zcode/v2/visualizations/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
  it("emits exactly 3 official blocks; cli_prefix plain, stable/dynamic ephemeral (3.15.1+ wire)", () => {
    const blocks = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.type).toBe("text");
    }
    // Block 1 lost its ephemeral breakpoint in 3.15.1 (present 3.12.3–3.14.4):
    // the wire serializer maps absent cacheControl to an omitted key.
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("block 1 is the bare CLI Prefix", () => {
    const [cli] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(cli.text).toBe("You are ZCode, an interactive coding agent");
  });

  it("block 2 = Agent Identity + ZCode Desktop Context, \\n\\n-joined (stable group)", () => {
    const [, stable] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(stable.text.startsWith("\nYou are an interactive ZCode agent that helps users with software engineering tasks.")).toBe(true);
    expect(stable.text).toContain("# Harness");
    // Current 3.7.7+ harness line (mid-conversation system turns)
    expect(stable.text).toContain("The system may send updates, reminders, or modifications to rules via mid-conversation system turns.");
    expect(stable.text).toContain("# ZCode Desktop Context");
    // Interactive views subsection (since 3.15.1) sits between the section
    // heading and Files & URLs, always at least the fallback + widget lines.
    expect(stable.text).toContain("# ZCode Desktop Context\n\n### Interactive views");
    const ivIdx = stable.text.indexOf("### Interactive views");
    const fauIdx = stable.text.indexOf("### Files & URLs");
    expect(fauIdx).toBeGreaterThan(ivIdx);
    expect(stable.text).toContain("- Widget modelContent may accompany a user input in <untrusted_gen_ui_state>.");
    expect(stable.text).toContain("### Inline Code Comments");
    // Identity section ends with the clickable-reference bullet, then \n\n + desktop
    expect(stable.text).toContain("it's clickable.\n\n# ZCode Desktop Context");
    // Desktop context ends with the ::code-comment example
    expect(stable.text.endsWith('start=10 end=11 priority=2}')).toBe(true);
  });

  it("default vizDir renders the 3-line Interactive views variant with a JSON-quoted dir", () => {
    const [, stable] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(stable.text).toContain("- This Desktop host supports Gen UI: completed assistant references to HTML fragments in the supplied session directory render inline, including on remote executors.");
    expect(stable.text).toContain(`- Writable, durable visualization directory for this session: ${JSON.stringify(VIZ_DIR)}. Save inline fragments here, outside the project. Other paths cannot be rendered.`);
    expect(stable.text).toContain("- Use the independent visualize skill for authoring instructions, styles and the restricted window.zcode bridge. Load the skill before generating an interactive view.");
    expect(stable.text).not.toContain("No visualization output directory is supplied");
  });

  it("block 3 = '\\n\\n' + Dynamic Behavior + Environment + Context Management (dynamic group)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
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
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(dynamic.text).toContain("match its comment density, naming, and idiom.\nOnly write a code comment");
  });

  it("byte-spot: 'exhaustive survey' has no trailing period (xTr literal)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(dynamic.text).toContain("not an exhaustive survey\n\n");
    expect(dynamic.text).not.toContain("not an exhaustive survey.");
  });

  it("environment lines carry the resolved env values", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined, "glm-5.3", ENV, "zai", VIZ_DIR);
    expect(dynamic.text).toContain("- Primary working directory: /home/dev/project");
    expect(dynamic.text).toContain("- Platform: linux");
    expect(dynamic.text).toContain("- Shell: bash");
    expect(dynamic.text).toContain("- OS Version: linux 6.8.0-49-generic x64");
    expect(dynamic.text).toContain("- Is a git repository: no");
  });

  it("client system keeps the 3-block shape; text stays out of the cacheable blocks (issue #71)", () => {
    const blocks = buildStartPlanSystem(
      [
        { type: "text", text: "User rule", cache_control: { type: "ephemeral" } },
        { type: "text", text: "" }, // dropped
        "raw string block", // joined
      ],
      "glm-5.3",
      ENV,
      "zai",
      VIZ_DIR,
    );
    // 2026-10-24 gateway rule (issue #71): the 2-block custom/subagent shape is
    // rejected under BOTH session types; the passing shape is the official
    // 3-block form. The client text is NOT folded into the blocks: they are the
    // cacheable prefix and must stay byte-stable across turns (a varying client
    // prompt would otherwise invalidate the whole conversation behind them).
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "You are ZCode, an interactive coding agent" });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text).not.toContain("User rule");
    expect(blocks[1].text).not.toContain("raw string block");
    expect(blocks[1].text).toContain("interactive ZCode agent");
    expect(blocks[1].text).toContain("# ZCode Desktop Context");
    expect(blocks[2].text).toContain("# Environment");
    expect(blocks[2].text).toContain("powered by the model named zai-api/glm-5.3.");
  });

  it("whitespace-only / absent client system keeps the default 3-block identity chain", () => {
    for (const system of [undefined, null, "", "   ", [], [{ type: "text", text: "  " }]]) {
      const blocks = buildStartPlanSystem(system, "glm-5.3", ENV, "zai", VIZ_DIR);
      expect(blocks).toHaveLength(3);
      expect(blocks[1].text).toContain("interactive ZCode agent");
      expect(blocks[2].text).toContain("# Environment");
    }
  });

  it("returns only the 3 official blocks for absent system", () => {
    expect(buildStartPlanSystem(undefined, undefined, ENV, undefined, VIZ_DIR)).toHaveLength(3);
    expect(buildStartPlanSystem(null, undefined, ENV, undefined, VIZ_DIR)).toHaveLength(3);
  });
});

describe("buildDesktopContextSection (bundle Ekn, Interactive views since 3.15.1)", () => {
  it("fallback variant (no dir): 1-line notice + widget line, then Files & URLs", () => {
    const out = buildDesktopContextSection(undefined);
    expect(out.startsWith("# ZCode Desktop Context\n\n### Interactive views\n- No visualization output directory is supplied; inline Gen UI is unavailable.\n- Widget modelContent")).toBe(true);
    expect(out).not.toContain("This Desktop host supports Gen UI");
  });

  it("escapes Windows paths exactly like the client's JSON.stringify(dir)", () => {
    const out = buildDesktopContextSection("C:\\Users\\dev\\.zcode\\v2\\visualizations\\abc123");
    expect(out).toContain(
      '- Writable, durable visualization directory for this session: "C:\\\\Users\\\\dev\\\\.zcode\\\\v2\\\\visualizations\\\\abc123". Save inline fragments here',
    );
  });

  it("joins heading / Interactive views / Files & URLs with \\n\\n (bundle array join)", () => {
    const out = buildDesktopContextSection(VIZ_DIR);
    expect(out).toContain("privateContent is not sent to the model.\n\n### Files & URLs");
    expect(out.endsWith('start=10 end=11 priority=2}')).toBe(true);
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
