/** Normalize Anthropic bodies for zcode-plan upstream (matches ZCode desktop). */

const MODEL_MAP: Record<string, string> = {
  "glm-5.2": "GLM-5.2",
  "glm-5-turbo": "GLM-5-Turbo",
  "glm-5.1": "GLM-5.1",
  "glm-4.7": "GLM-4.7",
};

export function normalizeStartPlanBody(body: string | undefined): string | undefined {
  if (!body) return body;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return body;
  }

  let changed = false;

  if (typeof parsed.model === "string") {
    const mapped = MODEL_MAP[parsed.model.toLowerCase()] ?? parsed.model;
    if (mapped !== parsed.model) {
      parsed.model = mapped;
      changed = true;
    }
  }

  if (parsed.stream !== true) {
    parsed.stream = true;
    changed = true;
  }

  const messages = parsed.messages;
  if (Array.isArray(messages)) {
    const bridged = messages.map((msg) => {
      if (typeof msg !== "object" || msg === null) return msg;
      const m = msg as Record<string, unknown>;
      if (typeof m.content === "string") {
        changed = true;
        return { ...m, content: [{ type: "text", text: m.content }] };
      }
      return msg;
    });
    if (changed) parsed.messages = bridged;
  }

  return changed ? JSON.stringify(parsed) : body;
}
