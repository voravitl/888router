import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
}));

const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("open-sse/utils/stream.js");
const { FORMATS } = await import("open-sse/translator/formats.js");
const { parseSSEToOpenAIResponse } = await import("open-sse/handlers/chatCore/sseToJsonHandler.js");
const { openAICompletionToResponses } = await import("open-sse/utils/completionToResponses.js");
const { translateNonStreamingResponse } = await import("open-sse/handlers/chatCore/nonStreamingHandler.js");
const { initState } = await import("open-sse/translator/index.js");
const { openaiResponsesToOpenAIResponse } = await import("open-sse/translator/response/openai-responses.js");
const { createResponsesApiTransformStream } = await import("open-sse/transformer/responsesTransformer.js");

const enc = (s) => new TextEncoder().encode(s);

const REFUSAL = "I can't help with that.";

/** A refusal-only whole-completion frame, as an upstream that answers a
 *  streaming request with one non-streaming frame does. */
function refusalFrame() {
  return 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":null,"refusal":"' + REFUSAL + '"},"finish_reason":"stop"}]}\n\n';
}

/** A refusal-only streamed frame (delta.refusal). */
function refusalDeltaFrame() {
  return 'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","refusal":"' + REFUSAL + '"},"finish_reason":"stop"}]}\n\n';
}

async function runTranslate(input, sourceFormat) {
  let completed = null;
  const stream = createSSETransformStreamWithLogger(
    FORMATS.OPENAI,
    sourceFormat,
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

/** Every `data:`/`event:` payload in an SSE blob, parsed. */
function parseEvents(output) {
  const events = [];
  for (const block of output.split(/\n\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const eventLine = trimmed.split("\n").find((l) => l.startsWith("event:"));
    const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.replace(/^data:\s*/, "").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push({ event: eventLine ? eventLine.slice(6).trim() : null, data: JSON.parse(payload) });
    } catch { /* non-JSON */ }
  }
  return events;
}

describe("refusal delivery — OpenAI passthrough (same format)", () => {
  it("forwards a refusal-only whole-completion frame as delta.refusal", async () => {
    const { output, completed } = await runPassthrough(refusalFrame());

    const events = parseEvents(output);
    const chunk = events.find((e) => e.data?.choices);
    expect(chunk).toBeTruthy();
    expect(chunk.data.choices[0].delta.refusal).toBe(REFUSAL);
    expect(chunk.data.choices[0].message).toBeUndefined();
    // The refusal is real content — the turn must not be recorded as empty.
    expect(completed?.content).toBe(REFUSAL);
  });

  it("records a refusal-only stream as content, not an empty stream", async () => {
    const { completed } = await runPassthrough(refusalDeltaFrame());
    expect(completed?.content).toBe(REFUSAL);
    expect(completed?.content?.length).toBeGreaterThan(0);
  });
});

describe("refusal delivery — Claude client format", () => {
  it("delivers a refusal-only frame as assistant text", async () => {
    const { output, completed } = await runTranslate(refusalFrame(), FORMATS.CLAUDE);

    expect(output).toContain("text_delta");
    expect(output).toContain(REFUSAL);
    expect(completed?.content).toBe(REFUSAL);
  });

  it("delivers a refusal delta as assistant text", async () => {
    const { output, completed } = await runTranslate(refusalDeltaFrame(), FORMATS.CLAUDE);

    expect(output).toContain("text_delta");
    expect(output).toContain(REFUSAL);
    expect(completed?.content).toBe(REFUSAL);
  });
});

describe("refusal delivery — Gemini/Antigravity client format", () => {
  it("delivers a refusal-only frame as a text part", async () => {
    const { output, completed } = await runTranslate(refusalFrame(), FORMATS.ANTIGRAVITY);

    expect(output).toContain(REFUSAL);
    expect(output).toContain("text");
    expect(completed?.content).toBe(REFUSAL);
  });
});

describe("refusal delivery — OpenAI Responses client format", () => {
  it("emits native refusal events and a refusal content part", async () => {
    const { output, completed } = await runTranslate(refusalFrame(), FORMATS.OPENAI_RESPONSES);

    const events = parseEvents(output);
    const refusalDelta = events.find((e) => e.event === "response.refusal.delta");
    expect(refusalDelta).toBeTruthy();
    expect(refusalDelta.data.delta).toBe(REFUSAL);

    const partAdded = events.find((e) => e.event === "response.content_part.added");
    expect(partAdded?.data.part.type).toBe("refusal");

    // The refusal must NOT be smuggled in as output_text.
    expect(events.some((e) => e.event === "response.output_text.delta")).toBe(false);
    expect(output).not.toContain("output_text.delta");

    expect(completed?.content).toBe(REFUSAL);
  });

  it("closes the refusal part as a refusal, not as output_text", async () => {
    const { output } = await runTranslate(refusalFrame(), FORMATS.OPENAI_RESPONSES);

    const events = parseEvents(output);
    const refusalDone = events.find((e) => e.event === "response.refusal.done");
    expect(refusalDone).toBeTruthy();
    expect(refusalDone.data.refusal).toBe(REFUSAL);

    const partDone = events.find((e) => e.event === "response.content_part.done");
    expect(partDone?.data.part.type).toBe("refusal");
    expect(partDone?.data.part.refusal).toBe(REFUSAL);

    const itemDone = events.find((e) => e.event === "response.output_item.done");
    expect(itemDone?.data.item.content[0].type).toBe("refusal");
    expect(itemDone?.data.item.content[0].refusal).toBe(REFUSAL);

    // No output_text close event for a refusal-only turn.
    expect(events.some((e) => e.event === "response.output_text.done")).toBe(false);
  });
});

describe("refusal accounting", () => {
  it("bills a refusal-only turn with non-zero output tokens", async () => {
    const { output } = await runTranslate(refusalFrame(), FORMATS.CLAUDE);

    const deltaLine = output.split("\n").find((line) => line.includes('"message_delta"'));
    expect(deltaLine).toBeTruthy();
    const payload = JSON.parse(deltaLine.replace(/^data:\s*/, ""));
    expect(payload.usage?.output_tokens).toBeGreaterThan(0);
  });
});

describe("refusal delivery — JSON (non-streaming) paths", () => {
  it("keeps a refusal on the OpenAI message instead of emptying the content", () => {
    const parsed = parseSSEToOpenAIResponse(refusalFrame(), "test-model");
    expect(parsed).toBeTruthy();
    expect(parsed.choices[0].message.refusal).toBe(REFUSAL);
  });

  it("keeps a refusal on a streamed-delta SSE frame", () => {
    const parsed = parseSSEToOpenAIResponse(refusalDeltaFrame(), "test-model");
    expect(parsed).toBeTruthy();
    expect(parsed.choices[0].message.refusal).toBe(REFUSAL);
  });

  it("does not count a frame that carries both delta and message twice", () => {
    // Regression: a frame that carries the answer under BOTH delta and
    // message would duplicate the text/refusal when both are read.
    const frame = 'data: {"id":"chatcmpl-test","object":"chat.completion","choices":[{"index":0,"delta":{"content":"hi","refusal":"' + REFUSAL + '"},"message":{"role":"assistant","content":"hi","refusal":"' + REFUSAL + '"},"finish_reason":"stop"}]}\n\n';
    const parsed = parseSSEToOpenAIResponse(frame, "test-model");
    expect(parsed.choices[0].message.content).toBe("hi");
    expect(parsed.choices[0].message.refusal).toBe(REFUSAL);
  });

  it("emits a refusal content part when converting a completion to Responses JSON", () => {
    const parsed = parseSSEToOpenAIResponse(refusalFrame(), "test-model");
    const responses = openAICompletionToResponses(parsed, parsed.usage || {});
    const messageItem = responses.output.find((item) => item.type === "message");
    expect(messageItem).toBeTruthy();
    expect(messageItem.content[0].type).toBe("refusal");
    expect(messageItem.content[0].refusal).toBe(REFUSAL);
  });

  it("reads a refusal out of a Responses output item", () => {
    const assembled = {
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: REFUSAL }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const chat = translateNonStreamingResponse(assembled, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI);
    expect(chat.choices[0].message.refusal).toBe(REFUSAL);
  });
});

describe("refusal delivery — Responses provider → OpenAI client (reverse direction)", () => {
  it("carries a response.refusal.delta onto delta.refusal", () => {
    const state = initState(FORMATS.OPENAI);
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.refusal.delta",
      output_index: 0,
      delta: REFUSAL,
    }, state);
    expect(chunk).toBeTruthy();
    expect(chunk.choices[0].delta.refusal).toBe(REFUSAL);
  });

  it("carries a compact response.refusal.done onto delta.refusal", () => {
    const state = initState(FORMATS.OPENAI);
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.refusal.done",
      output_index: 0,
      refusal: REFUSAL,
    }, state);
    expect(chunk).toBeTruthy();
    expect(chunk.choices[0].delta.refusal).toBe(REFUSAL);
  });

  it("carries a refusal content part from a message item", () => {
    const state = initState(FORMATS.OPENAI);
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "refusal", refusal: REFUSAL }] },
    }, state);
    expect(chunk).toBeTruthy();
    expect(chunk.choices[0].delta.refusal).toBe(REFUSAL);
  });

  it("reads the refusal from the part shape of a response.refusal.done", () => {
    const state = initState(FORMATS.OPENAI);
    const chunk = openaiResponsesToOpenAIResponse({
      type: "response.refusal.done",
      output_index: 0,
      part: { type: "refusal", refusal: REFUSAL },
    }, state);
    expect(chunk).toBeTruthy();
    expect(chunk.choices[0].delta.refusal).toBe(REFUSAL);
  });

  it("does not emit the refusal twice when a delta was already seen", () => {
    const state = initState(FORMATS.OPENAI);
    openaiResponsesToOpenAIResponse({
      type: "response.refusal.delta",
      output_index: 0,
      delta: REFUSAL,
    }, state);
    const second = openaiResponsesToOpenAIResponse({
      type: "response.refusal.done",
      output_index: 0,
      refusal: REFUSAL,
    }, state);
    expect(second).toBeNull();
  });
});

describe("refusal delivery — responsesTransformer (Chat Completions → Responses)", () => {
  it("emits a native refusal event instead of an empty text stream", async () => {
    const REFUSAL = "I can't help with that.";
    const frame = `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"refusal":"${REFUSAL}"},"finish_reason":"stop"}]}\n\n`;

    const inputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
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

    expect(result).toContain("response.refusal.delta");
    expect(result).toContain(REFUSAL);
    expect(result).not.toContain("response.output_text.delta");
  });
});
