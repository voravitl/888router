import { describe, it, expect } from "vitest";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Regression: opencode-go responses-only models (muse-spark/grok/gpt-luna).
// The request translator hardcodes stream:true for the Responses shape, so a
// client asking stream:false still gets Responses SSE back. The non-streaming
// handler fed that SSE to the chat-only parseSSEToOpenAIResponse (looks for
// choices[].delta.content — Responses events have none) → HTTP 200 with
// content:"". The fix assembles via convertResponsesStreamToJson first.
const RESPONSES_SSE = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_123","created_at":1790581300,"model":"muse-spark-1.3-contributor"}}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"4"}]}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_123","status":"completed","usage":{"input_tokens":100,"output_tokens":5,"total_tokens":105}}}',
  '',
].join("\n");

function sseBody() {
  return new Response(RESPONSES_SSE, {
    headers: { "content-type": "text/event-stream" },
  }).body;
}

describe("non-streaming Responses SSE (opencode-go muse-spark)", () => {
  it("assembles Responses SSE into message output + usage", async () => {
    const assembled = await convertResponsesStreamToJson(sseBody());
    expect(assembled.status).toBe("completed");
    expect(assembled.output).toHaveLength(1);
    expect(assembled.output[0].type).toBe("message");
    expect(assembled.usage.output_tokens).toBe(5);
  });

  it("translates assembled Responses JSON to chat completion text", async () => {
    const assembled = await convertResponsesStreamToJson(sseBody());
    const chat = translateNonStreamingResponse(
      assembled,
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    );
    expect(chat.choices[0].message.content).toBe("4");
    expect(chat.choices[0].finish_reason).toBe("stop");
    expect(chat.usage.completion_tokens).toBe(5);
  });

  it("documents the old bug: chat-only parser drops Responses events", () => {
    const parsed = parseSSEToOpenAIResponse(RESPONSES_SSE, "muse-spark-1.3-contributor");
    expect(parsed.choices[0].message.content).toBe("");
  });
});
