/**
 * Tests for the start-plan system-prompt assembly (ContextBuilder mirror).
 * Golden assertions anchor the byte-exact 3.17.1 bundle shapes:
 * `_reverse/glm/zcode.cjs` `Y8e` (ContextBuilder/assembleSystemMessages),
 * `U8e` (cli_prefix `uBa`), `wDn`/`fBa` (identity, default branch `dBa` +
 * security notice `nBo` + Harness `SDn` with " - " bullets), `TBo`
 * (dynamic behavior `[y3a,v3a,b3a]`), `IBo` (context management
 * `[S3a,w3a]`), `$5o`/`fce` (standalone "date" attachment, no heading).
 * Block shape per 3.15.1+ wire: cli_prefix block has NO cache_control
 * (`_reverse/NOTEPAD.md` "3.16.3 增补" §F; 3.17.1 assembly byte-identical,
 * "3.17.1 增补" 四轮). Desktop Context is deliberately NOT injected
 * (CLI-face state; gateway probe 2026-10-27, §J).
 */
import { describe, it, expect } from "bun:test";
import {
  buildStartPlanSystem,
  buildCurrentDateMessage,
  formatLocalIsoDate,
} from "./system-prompt.js";

describe("formatLocalIsoDate (bundle _Ne)", () => {
  it("formats local YYYY-MM-DD zero-padded", () => {
    expect(formatLocalIsoDate(new Date(2026, 8, 11))).toBe("2026-09-11");
    expect(formatLocalIsoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("buildStartPlanSystem (bundle assembleSystemMessages)", () => {
  it("emits exactly 3 official blocks; cli_prefix plain, stable/dynamic ephemeral (3.15.1+ wire)", () => {
    const blocks = buildStartPlanSystem(undefined);
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

  it("block 1 is the bare CLI Prefix (3.17.1 dropped 'coding')", () => {
    const [cli] = buildStartPlanSystem(undefined);
    expect(cli.text).toBe("You are ZCode, an interactive agent");
  });

  it("block 2 = Agent Identity alone, desktop context deliberately omitted (CLI-face state, NOTEPAD §J)", () => {
    const [, stable] = buildStartPlanSystem(undefined);
    expect(stable.text.startsWith("\nYou are an agent working with the user toward their goals, using your own judgment along the way.")).toBe(true);
    expect(stable.text).toContain("# Harness");
    // 3.17.1 harness bullets carry a leading space; bullet 3 takes the e=!0
    // default branch (mid-conversation system turns variant).
    expect(stable.text).toContain("# Harness\n - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.");
    expect(stable.text).toContain(" - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.");
    // Identity section ends with the clickable-reference bullet
    expect(stable.text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    // DELIBERATE DEVIATION from the desktop client: no Desktop Context behind identity
    expect(stable.text).not.toContain("# ZCode Desktop Context");
    expect(stable.text).not.toContain("### Interactive views");
    expect(stable.text).not.toContain("### Files & URLs");
    expect(stable.text).not.toContain("### Inline Code Comments");
  });

  it("block 3 is EMPTY on the default path (minimal-set anchoring 2026-10-30, probe M1)", () => {
    const [, , dynamic] = buildStartPlanSystem(undefined);
    // Official 3.17.1 default ships the Dynamic Behavior + Context Management
    // duo here; the gateway constrains block 3 not at all (M1 empty / M3
    // prefix-only / N09 no-prefix all 200) — omitted for token economy.
    // The duo texts stay in zcode_system.json as the official-shape record.
    expect(dynamic.text).toBe("");
    expect(dynamic.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sidecar dynamicSections remain the official 3.17.1 record (byte anchors)", async () => {
    const { dynamicSections } = await import("./zcode_system.json", { with: { type: "json" } });
    expect(dynamicSections.dynamicBehavior).toContain("never infer pronouns from a name. This applies to all user-visible text, including visible thinking.");
    expect(dynamicSections.dynamicBehavior).toContain("Before deleting or overwriting, look at the target. Report outcomes faithfully");
    expect(dynamicSections.contextManagement.endsWith("not an exhaustive survey")).toBe(true);
    expect(dynamicSections.contextManagement).not.toContain("not an exhaustive survey.");
  });

  it("client system keeps the 3-block shape; text becomes block 3 (C1: replaces the dynamic duo, §J live-proven)", () => {
    const blocks = buildStartPlanSystem([
      { type: "text", text: "User rule", cache_control: { type: "ephemeral" } },
      { type: "text", text: "" }, // dropped
      "raw string block", // joined
    ]);
    // §J unified rules (2026-10-27): block 3 is unconstrained and block 2 must
    // only OPEN with the full stable text — the C1 form puts the client text
    // in block 3 so block 2 stays byte-exact pure stable (tightening-immune).
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: "text", text: "You are ZCode, an interactive agent" });
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    // Block 2 = pure stable text; the client text does NOT touch it.
    expect(blocks[1].text.endsWith(" - Reference code as `file_path:line_number` — it's clickable.")).toBe(true);
    expect(blocks[1].text).toContain("working with the user toward their goals");
    expect(blocks[1].text).not.toContain("User rule");
    expect(blocks[1].text).not.toContain("# ZCode Desktop Context");
    // Block 3 = "\n\n" + client text alone; the dynamic duo is replaced.
    expect(blocks[2].text).toBe("\n\nUser rule\n\nraw string block");
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("whitespace-only / absent client system keeps the default 3-block identity chain (empty block 3)", () => {
    for (const system of [undefined, null, "", "   ", [], [{ type: "text", text: "  " }]]) {
      const blocks = buildStartPlanSystem(system);
      expect(blocks).toHaveLength(3);
      expect(blocks[1].text).toContain("working with the user toward their goals");
      expect(blocks[2].text).toBe("");
    }
  });

  it("returns only the 3 official blocks for absent system", () => {
    expect(buildStartPlanSystem(undefined)).toHaveLength(3);
    expect(buildStartPlanSystem(null)).toHaveLength(3);
  });
});

describe("buildCurrentDateMessage (bundle $5o + fce: standalone date attachment)", () => {
  it("emits a user turn wrapping the bare date line in a system-reminder (no heading since 3.17.1)", () => {
    const msg = buildCurrentDateMessage(new Date(2026, 8, 11));
    expect(msg.role).toBe("user");
    expect(msg.content).toEqual([
      {
        type: "text",
        text: "<system-reminder>Today's date is 2026-09-11.</system-reminder>",
      },
    ]);
  });

  it("carries no cache_control (attachments never get breakpoints)", () => {
    const msg = buildCurrentDateMessage(new Date(2026, 8, 11));
    expect(msg.content[0].cache_control).toBeUndefined();
  });
});
