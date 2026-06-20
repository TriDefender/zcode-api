import systemBlocks from "./zcode_system.json" with { type: "json" };

type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/** Official ZCode gateway blocks (positions 0/1) — required or upstream returns 3012. */
export const ZCODE_SYSTEM_BLOCKS = systemBlocks as SystemBlock[];

function normalizeUserSystem(system: unknown): SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(system)) return [];
  const out: SystemBlock[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
    } else if (item && typeof item === "object" && (item as SystemBlock).type === "text") {
      const b = item as SystemBlock;
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (text) {
        out.push({
          type: "text",
          text,
          ...(b.cache_control ? { cache_control: b.cache_control } : {}),
        });
      }
    }
  }
  return out;
}

/** Prepend official blocks; client system (if any) goes after position 1. */
export function injectOfficialZcodeSystem(body: Record<string, unknown>): boolean {
  const userBlocks = normalizeUserSystem(body.system);
  const official = ZCODE_SYSTEM_BLOCKS.map((b) => structuredClone(b));
  const next = [...official, ...userBlocks];
  const prev = JSON.stringify(body.system ?? null);
  body.system = next;
  return prev !== JSON.stringify(next);
}
