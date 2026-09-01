import { describe, it, expect } from "vitest";

const streamMod = await import("../../open-sse/utils/stream.js");

// `createSSETransformStreamWithLogger` returns a WHATWG TransformStream — drive
// it directly via getWriter/getReader rather than going through Node's pipe.
async function runStream(lines, opts = {}) {
  let captured = null;
  const transform = streamMod.createSSETransformStreamWithLogger(
    opts.target || "openai",
    opts.source || "openai",
    "test",
    null,
    null,
    opts.model || "gpt-4o",
    null,
    null,
    (result) => { captured = result; },
  );
  const text = lines.map((l) => (l.endsWith("\n") ? l : l + "\n")).join("");
  // Run writer + reader concurrently so the transform's flush() fires.
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const pump = (async () => {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  })();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  await pump;
  return captured;
}

describe("accumulatedToolCalls in createSSETransformStreamWithLogger", () => {
  it("OpenAI: counts unique tool_calls across streaming deltas (id-based dedup)", async () => {
    const captured = await runStream([
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"get_time","arguments":"{}"}}]}}]}`,
      `data: [DONE]`,
    ]);
    expect(captured.content).toBe("");
    expect(captured.thinking).toBe("");
    expect(captured.toolCalls).toHaveLength(2);
    expect(captured.toolCalls.map((c) => c.name).sort()).toEqual(["get_time", "get_weather"]);
  });

  it("OpenAI: tool_calls without id still counts (index-based dedup)", async () => {
    const captured = await runStream([
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"a","arguments":""}}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"name":"b","arguments":"{}"}}]}}]}`,
      `data: [DONE]`,
    ]);
    expect(captured.toolCalls).toHaveLength(2);
    expect(captured.toolCalls.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("Claude: detects tool_use via content_block_start", async () => {
    const captured = await runStream(
      [
        `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
      ],
      { target: "anthropic", source: "anthropic", model: "claude-opus-4-6" },
    );
    expect(captured.content).toBe("");
    expect(captured.toolCalls).toHaveLength(1);
    expect(captured.toolCalls[0].name).toBe("get_weather");
  });

  it("Mixed text + tool_calls: both counted", async () => {
    const captured = await runStream([
      `data: {"choices":[{"index":0,"delta":{"content":"Calling "}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":""}}]}}]}`,
      `data: [DONE]`,
    ]);
    expect(captured.content).toBe("Calling ");
    expect(captured.toolCalls).toHaveLength(1);
    expect(captured.toolCalls[0].name).toBe("search");
  });

  it("Plain text only: toolCalls stays null (no array allocation)", async () => {
    const captured = await runStream([
      `data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}`,
      `data: {"choices":[{"index":0,"delta":{"content":"world"}}]}`,
      `data: [DONE]`,
    ]);
    expect(captured.content).toBe("Hello world");
    expect(captured.toolCalls).toBeNull();
  });
});
