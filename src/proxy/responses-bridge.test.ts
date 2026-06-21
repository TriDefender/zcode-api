import { describe, expect, it } from "bun:test";
import { anthropicSseToResponsesSse } from "./responses-bridge.js";

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parseEvents(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of raw.split("\n\n")) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let event = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (event && dataStr) {
      events.push({ event, data: JSON.parse(dataStr) as Record<string, unknown> });
    }
  }
  return events;
}

describe("anthropicSseToResponsesSse", () => {
  it("emits output_item.done for function_call before response.completed", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const chunks = [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_abc","name":"write"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ];
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });

    const events = parseEvents(await collectSse(anthropicSseToResponsesSse(upstream, "glm-5.2")));
    const names = events.map((e) => e.event);
    const doneIdx = names.indexOf("response.output_item.done");
    const completedIdx = names.indexOf("response.completed");
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(doneIdx);

    const done = events[doneIdx]!;
    expect(done.data.item).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
      name: "write",
      arguments: '{"path":"a"}',
    });

    const completed = events[completedIdx]!;
    const response = completed.data.response as Record<string, unknown>;
    const output = response.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
      name: "write",
    });
  });
});
