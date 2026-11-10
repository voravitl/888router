import { describe, expect, it } from "vitest";
import { createComboStreamGuard } from "../../open-sse/services/comboStreamGuard.js";
import { createStreamToolShimTransformStream } from "../../open-sse/transformer/streamToolShim.js";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Claude tool stream and combo guard integrity", () => {
  it("comboStreamGuard recognizes Claude whole-completion message frame over SSE as sawText=true", () => {
    const guard = createComboStreamGuard();
    const messageFrame = "data: " + JSON.stringify({
      id: "msg_123",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Thinking about the answer..." },
        { type: "text", text: "Claude was developed by Anthropic." }
      ],
      stop_reason: "end_turn"
    }) + "\n\n";

    guard.feed(Buffer.from(messageFrame));
    guard.feedEnd();

    expect(guard.isEmpty()).toBe(false);
    expect(guard.sawReasoning()).toBe(true);
  });

  it("comboStreamGuard recognizes Claude tool-only message frame as sawText=true", () => {
    const guard = createComboStreamGuard();
    const toolMessage = "data: " + JSON.stringify({
      id: "msg_tool_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }
      ],
      stop_reason: "tool_use"
    }) + "\n\n";

    guard.feed(Buffer.from(toolMessage));
    guard.feedEnd();

    expect(guard.isEmpty()).toBe(false);
  });

  it("streamToolShim flushes buffered content_block_start when text_delta arrives without dropping start or stop", async () => {
    const tools = [{ name: "Bash" }, { name: "advisor" }];
    const shim = createStreamToolShimTransformStream(tools, "claude");

    const chunks = [
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-5-5\",\"stop_reason\":null}}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello world\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
    ];

    const emitted = [];
    const writer = shim.writable.getWriter();
    const reader = shim.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        emitted.push(new TextDecoder().decode(value));
      }
    })();

    for (const c of chunks) {
      await writer.write(Buffer.from(c));
    }
    await writer.close();
    await readPromise;

    const fullOutput = emitted.join("");
    expect(fullOutput).toContain("content_block_start");
    expect(fullOutput).toContain("Hello world");
    expect(fullOutput).toContain("content_block_stop");
    expect(fullOutput).toContain("message_stop");
  });

  it("streamToolShim preserves whitespace-only text deltas", async () => {
    const shim = createStreamToolShimTransformStream([], "claude");
    const chunks = [
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"   \\n  \"}}\n\n"
    ];

    const emitted = [];
    const writer = shim.writable.getWriter();
    const reader = shim.readable.getReader();

    const readPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        emitted.push(new TextDecoder().decode(value));
      }
    })();

    for (const c of chunks) {
      await writer.write(Buffer.from(c));
    }
    await writer.close();
    await readPromise;

    const fullOutput = emitted.join("");
    expect(fullOutput).toContain("   \\n  ");
  });

  it("hasValuableContent retains signature_delta in Claude format", () => {
    const signatureChunk = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: "CAQSigYKEAgTGAI4AUIIdGhpbmtpbmc="
      }
    };
    expect(hasValuableContent(signatureChunk, FORMATS.CLAUDE)).toBe(true);
  });

  it("hasValuableContent discards empty content_block_delta without text, thinking, signature, or input_json", () => {
    const emptyChunk = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "unknown_delta"
      }
    };
    expect(hasValuableContent(emptyChunk, FORMATS.CLAUDE)).toBe(false);
  });
});
