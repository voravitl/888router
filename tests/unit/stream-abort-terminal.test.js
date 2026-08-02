import { describe, it, expect } from "vitest";
import { buildAbortedClaudeTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";
import { createStreamToolShimTransformStream } from "../../open-sse/transformer/streamToolShim.js";

function decode(bytes) {
  return new TextDecoder().decode(bytes);
}

describe("buildAbortedClaudeTerminalBytes", () => {
  it("closes open blocks before message_delta + message_stop", () => {
    const out = decode(buildAbortedClaudeTerminalBytes(new Set([0, 1])));
    expect(out).toContain('"type":"content_block_stop","index":0');
    expect(out).toContain('"type":"content_block_stop","index":1');
    // stop blocks must precede the terminal events
    expect(out.indexOf("content_block_stop")).toBeLessThan(out.indexOf("message_delta"));
    expect(out.indexOf("message_delta")).toBeLessThan(out.indexOf("message_stop"));
    expect(out).toContain('"stop_reason":"end_turn"');
  });

  it("emits only terminal events when no blocks are open", () => {
    const out = decode(buildAbortedClaudeTerminalBytes(new Set()));
    expect(out).not.toContain("content_block_stop");
    expect(out).toContain("message_delta");
    expect(out).toContain("message_stop");
  });

  it("tolerates null openBlockIndices", () => {
    const out = decode(buildAbortedClaudeTerminalBytes(null));
    expect(out).not.toContain("content_block_stop");
    expect(out).toContain("message_stop");
  });
});

describe("pipeWithDisconnect abort terminal closes open blocks", () => {
  it("synthesizes content_block_stop for open blocks when the client disconnects mid-stream", async () => {
    // A provider stream that emits a thinking block start then stalls (client
    // disconnect path). We flip isConnected() to false AFTER the first chunk is
    // scanned, so the disconnect-aware stream fires emitTerminal with the open
    // block index it tracked.
    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          "event: content_block_start\n" +
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}\n\n'
        ));
        // Never close the block — leave it open and end the upstream body.
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    // Identity transform — no format translation needed to exercise the scanner.
    const transform = new TransformStream({ transform(c, e) { e.enqueue(c); } });

    let connected = true;
    const controller = {
      isConnected: () => connected,
      handleComplete: () => {},
      handleError: () => {},
      handleDisconnect: () => {},
      abort: () => {},
      signal: null,
      startTime: Date.now(),
    };

    const stream = pipeWithDisconnect(
      providerResponse, transform, controller, buildAbortedClaudeTerminalBytes, 5000
    );

    const reader = stream.getReader();
    let all = "";

    // First pull: reads the block start, scans it (index 0 → open), enqueues.
    {
      const { done, value } = await reader.read();
      if (!done) all += decode(value);
    }

    // Simulate client disconnect: flip isConnected false, then the next pull
    // must synthesize terminal that closes the still-open thinking block.
    connected = false;
    {
      const { value } = await reader.read();
      if (value) all += decode(value);
    }

    // The scanner saw the open thinking block (index 0); the abort terminal must
    // close it before message_stop → otherwise Claude Code would report
    // "Content block not found".
    expect(all).toContain('"type":"content_block_stop","index":0');
    expect(all.indexOf("content_block_stop")).toBeLessThan(all.indexOf("message_stop"));
  });

  it("tracks a block whose content_block_start data: line is split across chunks", async () => {
    // Send the start event split mid-payload (L3: chunk-boundary scanning).
    // The scanner must reassemble the line before JSON.parse, otherwise the
    // open block index is missed and the abort terminal emits no stop.
    const chunk1 = 'event: content_block_start\n' + 'data: {"type":"content_block_start","index":0,"content_';
    const chunk2 = 'block":{"type":"thinking","thinking":"","signature":"sig"}}\n\n';
    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk1));
        controller.enqueue(new TextEncoder().encode(chunk2));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const transform = new TransformStream({ transform(c, e) { e.enqueue(c); } });

    let connected = true;
    const controller = {
      isConnected: () => connected,
      handleComplete: () => {},
      handleError: () => {},
      handleDisconnect: () => {},
      abort: () => {},
      signal: null,
      startTime: Date.now(),
    };

    const stream = pipeWithDisconnect(providerResponse, transform, controller, buildAbortedClaudeTerminalBytes, 5000);
    const reader = stream.getReader();
    let all = "";

    // Drain both chunks (scanner reassembles the split data: line).
    for (let i = 0; i < 2; i++) {
      const { done, value } = await reader.read();
      if (!done) all += decode(value);
    }

    // Disconnect → terminal must close block index 0.
    connected = false;
    {
      const { value } = await reader.read();
      if (value) all += decode(value);
    }

    expect(all).toContain('"type":"content_block_stop","index":0');
    expect(all.indexOf("content_block_stop")).toBeLessThan(all.indexOf("message_stop"));
  });

  it("closes a block whose content_block_stop is still buffered (mid-line) at abort", async () => {
    // Upstream sends a start, then a stop whose data: line is cut off with no
    // trailing newline in the final chunk. scanBuffered() (called by
    // emitTerminal) must still parse the stop and remove index 0 from the open
    // set → the abort terminal should NOT re-close it (M2: avoid double-stop).
    const start = 'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
    const stopPartial = 'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}'; // no trailing newline → stays in buffer

    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(start));
        controller.enqueue(new TextEncoder().encode(stopPartial));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const transform = new TransformStream({ transform(c, e) { e.enqueue(c); } });

    let connected = true;
    const controller = {
      isConnected: () => connected,
      handleComplete: () => {},
      handleError: () => {},
      handleDisconnect: () => {},
      abort: () => {},
      signal: null,
      startTime: Date.now(),
    };

    const stream = pipeWithDisconnect(providerResponse, transform, controller, buildAbortedClaudeTerminalBytes, 5000);
    const reader = stream.getReader();
    let all = "";

    for (let i = 0; i < 2; i++) {
      const { done, value } = await reader.read();
      if (!done) all += decode(value);
    }

    // Disconnect → scanBuffered() should consume the pending stop before the
    // terminal is built, so openBlockIndices is empty → the synthesized
    // terminal (only read3 output) has no content_block_stop.
    connected = false;
    let terminal = "";
    {
      const { value } = await reader.read();
      if (value) terminal += decode(value);
    }

    // The buffered stop was consumed: the abort terminal must NOT re-close
    // index 0 (it was already closed by the buffered stop).
    expect(terminal).not.toContain('"type":"content_block_stop"');
    expect(terminal).toContain("message_stop");
    expect(terminal).toContain("message_delta");
  });

  it("does not emit orphan stops when the tool shim closes its tool_use block before disconnect", async () => {
    // Regression guard: the universal tool shim allocates a tool_use block and
    // (per-chunk, in emitToolCallChunk) closes it immediately with start+delta+
    // stop. Because the shim runs BEFORE pipeWithDisconnect, the disconnect
    // scanner sees that closed block and correctly leaves openBlockIndices
    // empty. On client disconnect, the abort terminal must NOT emit an orphan
    // content_block_stop (which Claude Code rejects as "Content block not
    // found"), and message_stop must still be last.
    const tools = [{ name: "Bash", description: "run a command", input_schema: { type: "object", properties: {} } }];
    const shim = createStreamToolShimTransformStream(tools, "claude");

    const providerResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"<tool_call>"}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"name\\":\\"Bash\\",\\"arguments\\":{\\"command\\":\\"ls\\"}}</tool_call>"}}\n\n'
        ));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const identity = new TransformStream({ transform(c, e) { e.enqueue(c); } });
    const transform = { readable: identity.readable.pipeThrough(shim), writable: identity.writable };

    let connected = true;
    const controller = {
      isConnected: () => connected,
      handleComplete: () => {},
      handleError: () => {},
      handleDisconnect: () => {},
      abort: () => {},
      signal: null,
      startTime: Date.now(),
    };

    const stream = pipeWithDisconnect(providerResponse, transform, controller, buildAbortedClaudeTerminalBytes, 5000);
    const reader = stream.getReader();
    let all = "";

    // Drain until the shim has emitted the tool_use block (which it closes).
    for (let i = 0; i < 3; i++) {
      const { done, value } = await reader.read();
      if (!done) all += decode(value);
    }

    // Disconnect → abort terminal runs. openBlockIndices is empty (shim closed
    // the block), so the terminal must add NO content_block_stop.
    connected = false;
    {
      const { value } = await reader.read();
      if (value) all += decode(value);
    }

    // The tool_use block exists and the shim closed it.
    expect(all).toContain('"type":"tool_use"');

    // Count starts vs stops across the whole output: every stop must have a
    // matching start (no orphan stops), and message_stop must be the last event.
    const starts = (all.match(/"type":"content_block_start"/g) || []).length;
    const stops = (all.match(/"type":"content_block_stop"/g) || []).length;
    expect(starts).toBe(stops);
    expect(all.indexOf("message_stop")).toBeGreaterThan(all.lastIndexOf("content_block_stop"));
  });
});
