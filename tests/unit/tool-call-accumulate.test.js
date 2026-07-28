import { describe, it, expect } from "vitest";
import { accumulateToolName } from "open-sse/translator/concerns/toolCall.js";
import { createResponsesApiTransformStream } from "open-sse/transformer/responsesTransformer.js";

describe("accumulateToolName helper", () => {
  it("handles empty initial state", () => {
    expect(accumulateToolName(undefined, "get_weather")).toBe("get_weather");
    expect(accumulateToolName(null, "get_weather")).toBe("get_weather");
    expect(accumulateToolName("", "get_weather")).toBe("get_weather");
  });

  it("handles empty incoming fragment", () => {
    expect(accumulateToolName("get_weather", "")).toBe("get_weather");
    expect(accumulateToolName("get_weather", null)).toBe("get_weather");
    expect(accumulateToolName("get_weather", undefined)).toBe("get_weather");
  });

  it("accumulates split chunks (e.g. 'Re' + 'ad')", () => {
    let name = "";
    name = accumulateToolName(name, "get_");
    expect(name).toBe("get_");
    name = accumulateToolName(name, "weather");
    expect(name).toBe("get_weather");
  });

  it("handles full re-echo ('get_weather' + 'get_weather')", () => {
    let name = "get_weather";
    name = accumulateToolName(name, "get_weather");
    expect(name).toBe("get_weather");
  });

  it("handles growing snapshot ('get_' → 'get_weather')", () => {
    let name = "get_";
    name = accumulateToolName(name, "get_weather");
    expect(name).toBe("get_weather");
  });

  it("handles shorter re-echo of already completed name ('get_weather' + 'get_')", () => {
    let name = "get_weather";
    name = accumulateToolName(name, "get_");
    expect(name).toBe("get_weather");
  });
});

describe("responsesTransformer tool name accumulation", () => {
  it("accumulates split function names across SSE chunks", async () => {
    // Simulate OpenAI ChatCompletions SSE chunks with split tool call function name
    const chunks = [
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_","arguments":""}}]},"finish_reason":null}]}\n\n`,
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"{\\"location\\": \\"Tokyo\\"}"}}]},"finish_reason":null}]}\n\n`,
      `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
      `data: [DONE]\n\n`
    ];

    const inputStream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const transformStream = createResponsesApiTransformStream();
    const transformedStream = inputStream.pipeThrough(transformStream);
    const reader = transformedStream.getReader();
    const decoder = new TextDecoder();
    let result = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    expect(result).toContain('"name":"get_"');
    expect(result).toContain('"name":"get_weather"');
    expect(result).toContain('"delta":"{\\"location\\": \\"Tokyo\\"}"');
  });
});
