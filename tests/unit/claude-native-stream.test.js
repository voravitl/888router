import { describe, expect, it, vi } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

const { createClaudeNativeStreamWithLogger } = await import("../../open-sse/utils/stream.js");

async function runChunks(chunks) {
  let completion;
  const transform = createClaudeNativeStreamWithLogger(
    "claude", null, "claude-test", "connection-1", {},
    (...args) => { completion = args; },
  );
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const output = [];
  const read = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(value);
    }
  })();
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  await read;
  return { output: Buffer.concat(output.map((chunk) => Buffer.from(chunk))), completion };
}

describe("Claude native stream observer", () => {
  it("preserves all bytes and observes text, thinking, usage, ping, signatures and unknown events", async () => {
    const source = [
      ": ping\r\n\r\n",
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":17,"output_tokens":1,"cache_read_input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"let me think"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"héllo"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig_abc"}}\n\n',
      'event: future_event\ndata: {"type":"future_event","opaque":{"x":1}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    ].join("");
    const bytes = Buffer.from(source);
    const splitAt = bytes.indexOf(Buffer.from("é")) + 1; // split the multibyte code point
    const { output, completion } = await runChunks([bytes.subarray(0, splitAt), bytes.subarray(splitAt)]);

    expect(output.equals(bytes)).toBe(true);
    expect(output.toString()).not.toContain("[DONE]");
    expect(completion[0]).toEqual({ content: "héllo", thinking: "let me think", toolCalls: null });
    expect(completion[1]).toMatchObject({ prompt_tokens: 17, completion_tokens: 9, cache_read_input_tokens: 4 });
  });

  it("records tool-only replies and parses a final event without a newline", async () => {
    const source = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}';
    const { output, completion } = await runChunks([Buffer.from(source)]);
    expect(output.toString()).toBe(source);
    expect(completion[0]).toEqual({ content: "", thinking: "", toolCalls: [{ id: "toolu_1", name: "read_file" }] });
    expect(completion[1]).toMatchObject({ completion_tokens: 3 });
  });

  it("discards an event with too many empty data lines and resumes at the next event", async () => {
    const oversizedEvent = `${"data:\n".repeat(2050)}\n`;
    const nextEvent = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"after"}}\n\n';
    const source = oversizedEvent + nextEvent;
    const { output, completion } = await runChunks([Buffer.from(source)]);
    expect(output.toString()).toBe(source);
    expect(completion[0].content).toBe("after");
  });

  it("skips a fragmented oversized line without changing bytes or losing following events", async () => {
    const prefix = Buffer.from("data: ");
    const oversizedLine = Buffer.from("x".repeat(70 * 1024));
    const suffix = Buffer.from('\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"recovered"}}\n\n');
    const chunks = [prefix, oversizedLine.subarray(0, 40 * 1024), oversizedLine.subarray(40 * 1024), suffix];
    const source = Buffer.concat(chunks);
    const { output, completion } = await runChunks(chunks);
    expect(output.equals(source)).toBe(true);
    expect(completion[0].content).toBe("recovered");
  });

  it("propagates ECONNRESET after a partial native Claude frame without appending a success terminal", async () => {
    const prefix = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial';
    const reset = Object.assign(new Error("upstream socket reset"), { code: "ECONNRESET" });
    let sent = false;
    const upstream = new Response(new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(Buffer.from(prefix));
        } else {
          controller.error(reset);
        }
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const transform = createClaudeNativeStreamWithLogger("claude", null, "claude-test", "connection-1", {});
    const streamController = {
      isConnected: () => true,
      handleComplete: vi.fn(),
      handleError: vi.fn(),
      handleDisconnect: vi.fn(),
      abort: vi.fn(),
      signal: null,
      startTime: Date.now(),
    };

    const output = pipeWithDisconnect(upstream, transform, streamController, null, 5000, { propagateUpstreamErrors: true });
    const reader = output.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value).toString()).toBe(prefix);
    await expect(reader.read()).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(streamController.handleError).toHaveBeenCalledWith(reset);
  });

  it("rejects an idle native stream when the stall watchdog fires", async () => {
    const onError = vi.fn();
    const streamController = createStreamController({ provider: "claude", model: "claude-test", onError });
    const upstream = new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const identity = new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } });
    const output = pipeWithDisconnect(upstream, identity, streamController, null, 20, { propagateUpstreamErrors: true });
    const reader = output.getReader();

    await expect(reader.read()).rejects.toThrow("stream stall timeout");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("surfaces a stall after a buffered partial frame when the consumer resumes", async () => {
    const prefix = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial';
    const onError = vi.fn();
    const streamController = createStreamController({ provider: "claude", model: "claude-test", onError });
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(prefix)); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const nativeObserver = createClaudeNativeStreamWithLogger("claude", null, "claude-test", null, {}, () => {});
    const output = pipeWithDisconnect(upstream, nativeObserver, streamController, null, 20, { propagateUpstreamErrors: true });
    const reader = output.getReader();

    const first = await reader.read();
    expect(Buffer.from(first.value).toString()).toBe(prefix);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(reader.read()).rejects.toThrow("stream stall timeout");
    expect(onError).toHaveBeenCalledOnce();
  });
});
