import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

const { createComboStreamGuard } = await import("open-sse/services/comboStreamGuard.js");
const {
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger,
  createClaudeNativeStreamWithLogger,
} = await import("open-sse/utils/stream.js");
const { FORMATS } = await import("open-sse/translator/formats.js");

const enc = (s) => new TextEncoder().encode(s);

async function drainStream(stream, chunks) {
  const readPromise = new Response(stream.readable).text();
  const writer = stream.writable.getWriter();
  for (const chunk of chunks) {
    await writer.write(typeof chunk === "string" ? enc(chunk) : chunk);
  }
  await writer.close();
  return readPromise;
}

describe("comboStreamGuard omitted-thinking budget exhaustion & refusal detection", () => {
  it("classifies omitted-thinking Claude->OpenAI stream with reasoning_tokens > 0 and no <think> tags as reasoning exhaustion", () => {
    const g = createComboStreamGuard();
    g.feed(enc('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
    g.feed(enc('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":20,"completion_tokens":256,"total_tokens":276,"completion_tokens_details":{"reasoning_tokens":256}}}\n\n'));
    g.feed(enc("data: [DONE]\n\n"));

    expect(g.isEmpty()).toBe(true);
    expect(g.sawReasoning()).toBe(true);
    expect(g.finishReason()).toBe("length");
  });

  it("classifies omitted-thinking Claude->OpenAI stream with completion_tokens > 0 (without completion_tokens_details) and finish_reason:length as reasoning exhaustion", () => {
    const g = createComboStreamGuard();
    g.feed(enc('data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
    g.feed(enc('data: {"id":"chatcmpl-2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":20,"completion_tokens":256,"total_tokens":276}}\n\n'));
    g.feed(enc("data: [DONE]\n\n"));

    expect(g.isEmpty()).toBe(true);
    expect(g.sawReasoning()).toBe(true);
    expect(g.finishReason()).toBe("length");
  });

  it("classifies omitted-thinking Anthropic native stream with output_tokens > 0 and stop_reason:max_tokens as reasoning exhaustion", () => {
    const g = createComboStreamGuard();
    g.feed(enc('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}\n\n'));
    g.feed(enc('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":256,"output_tokens_details":{"thinking_tokens":256}}}\n\n'));
    g.feed(enc('event: message_stop\ndata: {"type":"message_stop"}\n\n'));

    expect(g.isEmpty()).toBe(true);
    expect(g.sawReasoning()).toBe(true);
    expect(g.finishReason()).toBe("max_tokens");
  });

  it("does not mark sawReasoning when finish_reason is stop with zero tokens and no text", () => {
    const g = createComboStreamGuard();
    g.feed(enc('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
    g.feed(enc('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10}}\n\n'));
    g.feed(enc("data: [DONE]\n\n"));

    expect(g.isEmpty()).toBe(true);
    expect(g.sawReasoning()).toBe(false);
    expect(g.finishReason()).toBe("stop");
  });

  it("classifies a stream with delta.refusal and finish_reason:content_filter as non-empty", () => {
    const g = createComboStreamGuard();
    g.feed(enc('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
    g.feed(enc('data: {"choices":[{"index":0,"delta":{"refusal":"Blocked"},"finish_reason":null}]}\n\n'));
    g.feed(enc('data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n'));
    g.feed(enc("data: [DONE]\n\n"));

    expect(g.hasDecision()).toBe(true);
    expect(g.isEmpty()).toBe(false);
    expect(g.finishReason()).toBe("content_filter");
  });
});

describe("onStreamComplete finishReason propagation across all 3 stream modes", () => {
  it("createSSETransformStreamWithLogger passes finishReason in contentObj to onStreamComplete", async () => {
    let completedObj = null;
    const stream = createSSETransformStreamWithLogger(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "claude",
      null,
      null,
      "claude-sonnet-5-6",
      "conn-1",
      { messages: [{ role: "user", content: "hi" }] },
      (contentObj) => {
        completedObj = contentObj;
      }
    );

    await drainStream(stream, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5-6","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":256}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    expect(completedObj).toBeTruthy();
    expect(completedObj.finishReason).toBe("length");
  });

  it("createPassthroughStreamWithLogger passes finishReason (e.g. content_filter / length) in contentObj to onStreamComplete", async () => {
    let completedObj = null;
    const stream = createPassthroughStreamWithLogger(
      "openai",
      null,
      "gpt-5.4",
      "conn-2",
      { messages: [{ role: "user", content: "hi" }] },
      (contentObj) => {
        completedObj = contentObj;
      }
    );

    await drainStream(stream, [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","refusal":"Blocked"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(completedObj).toBeTruthy();
    expect(completedObj.content).toBe("Blocked");
    expect(completedObj.finishReason).toBe("content_filter");
  });

  it("createClaudeNativeStreamWithLogger passes finishReason (e.g. refusal) in contentObj to onStreamComplete", async () => {
    let completedObj = null;
    const stream = createClaudeNativeStreamWithLogger(
      "claude",
      null,
      "claude-fable-5-2",
      "conn-3",
      { messages: [{ role: "user", content: "hi" }] },
      (contentObj) => {
        completedObj = contentObj;
      }
    );

    await drainStream(stream, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_refusal","type":"message","role":"assistant","content":[],"usage":{"input_tokens":15,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction","explanation":"Blocked"}},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    expect(completedObj).toBeTruthy();
    expect(completedObj.finishReason).toBe("refusal");
  });
});
