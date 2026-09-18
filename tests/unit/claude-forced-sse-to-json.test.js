import { describe, it, expect } from "vitest";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("handleForcedSSEToJson Claude format conversion", () => {
  it("converts Responses API SSE stream to Claude Message format with valid usage when sourceFormat is claude", async () => {
    // Simulates OpenCode muse-spark /responses SSE stream
    const events = [
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_123","status":"in_progress"}}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_123","role":"assistant","content":[{"type":"output_text","text":"Hi there!"}]}}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_123","status":"completed","usage":{"input_tokens":15,"output_tokens":3}}}\n\n`,
    ].join("");

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(events));
        controller.close();
      },
    });

    const mockReqConfig = {
      providerResponse: {
        headers: { get: () => "text/event-stream" },
        body: stream,
      },
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      body: { model: "oc/muse-spark-1.3-contributor-free[1m]", max_tokens: 1 },
      stream: false,
      trackDone: () => {},
      appendLog: () => {},
    };

    const res = await handleForcedSSEToJson(mockReqConfig);
    expect(res.success).toBe(true);

    const json = await res.response.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.content).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toBeDefined();
    expect(json.usage.input_tokens).toBe(15);
    expect(json.usage.output_tokens).toBe(3);
    // Guarantees Claude Code probe `Er.usage.input_tokens` does not throw
    expect(json.usage.input_tokens).toBeGreaterThan(0);
  });

  it("converts standard Chat Completions SSE stream to Claude Message format with valid usage when sourceFormat is claude", async () => {
    const sseContent = [
      `data: {"id":"chatcmpl-456","choices":[{"delta":{"content":"Hello world"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    const mockReqConfig = {
      providerResponse: {
        headers: { get: () => "text/event-stream" },
        text: async () => sseContent,
      },
      sourceFormat: FORMATS.CLAUDE,
      targetFormat: FORMATS.OPENAI,
      provider: "openrouter",
      model: "qwen",
      body: { model: "qwen", max_tokens: 1 },
      stream: false,
      trackDone: () => {},
      appendLog: () => {},
    };

    const res = await handleForcedSSEToJson(mockReqConfig);
    expect(res.success).toBe(true);

    const json = await res.response.json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(json.stop_reason).toBe("end_turn");
    expect(json.usage).toBeDefined();
    expect(json.usage.input_tokens).toBe(10);
    expect(json.usage.output_tokens).toBe(2);
  });
});
