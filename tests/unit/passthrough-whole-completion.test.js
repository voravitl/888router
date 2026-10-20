import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

const { normalizeWholeCompletionChunk } = await import("open-sse/utils/streamHelpers.js");
const { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } = await import("open-sse/utils/stream.js");
const { FORMATS } = await import("open-sse/translator/formats.js");

const enc = (s) => new TextEncoder().encode(s);

async function runPassthrough(input) {
  let completed = null;
  const stream = createPassthroughStreamWithLogger(
    "opencode",
    null,
    "beam-free",
    "test-conn",
    { messages: [{ role: "user", content: "hi" }] },
    (contentObj) => { completed = contentObj; }
  );
  const readPromise = new Response(stream.readable).text();
  const writer = stream.writable.getWriter();
  await writer.write(enc(input));
  await writer.close();
  const output = await readPromise;
  return { output, completed };
}

async function runTranslate(input) {
  let completed = null;
  const stream = createSSETransformStreamWithLogger(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    "opencode",
    null,
    null,
    "beam-free",
    "test-conn",
    { messages: [{ role: "user", content: "hi" }] },
    (contentObj) => { completed = contentObj; }
  );
  const readPromise = new Response(stream.readable).text();
  const writer = stream.writable.getWriter();
  await writer.write(enc(input));
  await writer.close();
  const output = await readPromise;
  return { output, completed };
}

describe("normalizeWholeCompletionChunk", () => {
  it("moves message.content into delta.content and drops message", () => {
    const chunk = {
      choices: [{ index: 0, message: { role: "assistant", content: "42" }, finish_reason: "stop" }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta).toMatchObject({ role: "assistant", content: "42" });
    expect(chunk.choices[0].message).toBeUndefined();
    expect(chunk.choices[0].finish_reason).toBe("stop");
  });

  it("concatenates array content parts", () => {
    const chunk = {
      choices: [{
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
        },
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.content).toBe("hello world");
    expect(chunk.choices[0].message).toBeUndefined();
  });

  it("routes thinking/reasoning parts to delta.reasoning_content, not content", () => {
    const chunk = {
      choices: [{
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "secret reasoning" },
            { type: "text", text: "the answer" },
          ],
        },
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.content).toBe("the answer");
    expect(chunk.choices[0].delta.reasoning_content).toBe("secret reasoning");
  });

  it("does not copy a Gemini thought part into delta.content", () => {
    const chunk = {
      choices: [{
        message: {
          role: "assistant",
          content: [
            { text: "private thinking", thought: true },
            { text: "the answer" },
          ],
        },
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.content).toBe("the answer");
    expect(chunk.choices[0].delta.reasoning_content).toBe("private thinking");
  });

  it("collects reasoning from aliases and thinking parts without duplicating aliases", () => {
    const chunk = {
      choices: [{
        message: {
          role: "assistant",
          reasoning_content: "first",
          reasoningContent: "first",
          content: [{ type: "thinking", text: "second" }],
        },
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.reasoning_content).toBe("firstsecond");
    expect(chunk.choices[0].delta.content).toBeUndefined();
  });

  it("returns true when a choice was normalized and false otherwise", () => {
    const whole = { choices: [{ message: { content: "42" } }] };
    expect(normalizeWholeCompletionChunk(whole)).toBe(true);
    const delta = { choices: [{ delta: { content: "hi" } }] };
    expect(normalizeWholeCompletionChunk(delta)).toBe(false);
  });

  it("moves tool calls into delta.tool_calls with an index", () => {
    const chunk = {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":1}' }, index: 0 },
    ]);
    expect(chunk.choices[0].message).toBeUndefined();
  });

  it("replaces an empty delta.tool_calls array with message tool calls", () => {
    const chunk = {
      choices: [{
        delta: { tool_calls: [] },
        message: {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
      }],
    };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe("lookup");
    expect(chunk.choices[0].message).toBeUndefined();
  });

  it("leaves a normal delta chunk unchanged", () => {
    const chunk = { choices: [{ delta: { content: "hi" } }] };
    const before = structuredClone(chunk);
    normalizeWholeCompletionChunk(chunk);
    expect(chunk).toEqual(before);
  });

  it("keeps an empty message/usage-only frame intact", () => {
    const chunk = { choices: [{ message: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    normalizeWholeCompletionChunk(chunk);
    expect(chunk.choices[0].message).toEqual({});
    expect(chunk.choices[0].delta).toBeUndefined();
  });
});

describe("passthrough whole-completion frames", () => {
  it("forwards message.content as delta.content and records the text", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\n\n';
    const { output, completed } = await runPassthrough(input);

    const dataLine = output.split("\n").find((line) => line.includes('"delta"'));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(payload.choices[0].message).toBeUndefined();
    expect(payload.object).toBe("chat.completion.chunk");
    expect(completed?.content).toBe("42");
  });

  it("normalizes even when id/object/created are already valid and finish_reason is null", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","created":123,"choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":null}]}\n\n';
    const { output, completed } = await runPassthrough(input);

    const dataLine = output.split("\n").find((line) => line.includes('"delta"'));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(payload.choices[0].message).toBeUndefined();
    expect(payload.object).toBe("chat.completion.chunk");
    expect(completed?.content).toBe("42");
  });

  it("forwards a legacy function_call and records it as a tool call", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"function_call":{"name":"lookup","arguments":"{}"}},"finish_reason":"function_call"}]}\n\n';
    const { output, completed } = await runPassthrough(input);

    const dataLine = output.split("\n").find((line) => line.includes('"delta"'));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.function_call).toEqual({ name: "lookup", arguments: "{}" });
    expect(completed?.toolCalls?.[0]?.name).toBe("lookup");
  });

  it("normalizes a final whole-completion line without a trailing newline", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}';
    const { output, completed } = await runPassthrough(input);

    // The residual line must be its own SSE event: a single \n would make the
    // following `data: [DONE]` part of the same payload.
    const firstFrame = output.split("\n\n")[0];
    const payload = JSON.parse(firstFrame.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(payload.choices[0].message).toBeUndefined();
    expect(payload.object).toBe("chat.completion.chunk");
    expect(payload.created).toBeTypeOf("number");
    expect(payload.usage).toBeTruthy();
    expect(output).not.toMatch(/\}\ndata: \[DONE\]/);
    expect(completed?.content).toBe("42");
  });

  it("terminates a frame that ends with exactly one trailing newline", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\n';
    const { output, completed } = await runPassthrough(input);

    const firstFrame = output.split("\n\n")[0];
    const payload = JSON.parse(firstFrame.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(output).toContain("}\n\ndata: [DONE]\n\n");
    expect(completed?.content).toBe("42");
  });

  it("does not add an extra blank line when the frame already ends with two newlines", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\n\n';
    const { output } = await runPassthrough(input);

    const firstFrame = output.split("\n\n")[0];
    const payload = JSON.parse(firstFrame.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(output).not.toContain("\n\n\n");
  });

  it("closes an open frame before a [DONE] sentinel with no blank line", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\ndata: [DONE]';
    const { output } = await runPassthrough(input);

    const firstFrame = output.split("\n\n")[0];
    const payload = JSON.parse(firstFrame.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.content).toBe("42");
    expect(output).toContain("}\n\ndata: [DONE]\n\n");
    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
  });

  it("does not duplicate [DONE] when the residual sentinel has no space or trailing newline", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\n\ndata:[DONE]';
    const { output } = await runPassthrough(input);

    expect(output.match(/\[DONE\]/g)).toHaveLength(1);
    expect(output.endsWith("\n\n")).toBe(true);
  });

  it("forwards message.tool_calls as delta.tool_calls", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"id\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n';
    const { output, completed } = await runPassthrough(input);

    const dataLine = output.split("\n").find((line) => line.includes('"delta"'));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
    expect(payload.choices[0].delta.tool_calls[0].function.name).toBe("lookup");
    expect(payload.choices[0].message).toBeUndefined();
    expect(completed?.toolCalls?.[0]?.name).toBe("lookup");
  });
});

describe("translate whole-completion frames (OpenAI upstream -> Claude client)", () => {
  it("normalizes message.content before translating to Claude SSE", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}\n\n';
    const { output, completed } = await runTranslate(input);

    expect(output).toContain("42");
    expect(output).toContain("content_block_delta");
    expect(output).not.toContain('"choices"');
    expect(completed?.content).toBe("42");
  });

  it("normalizes a final translate line without a trailing newline", async () => {
    const input = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"42"},"finish_reason":"stop"}]}';
    const { output, completed } = await runTranslate(input);

    expect(output).toContain("42");
    expect(output).toContain("content_block_delta");
    expect(completed?.content).toBe("42");
  });
});
