import { beforeEach, describe, expect, it, vi } from "vitest";
const persistence = vi.hoisted(() => ({ saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/lib/usageDb.js", () => ({ appendRequestLog: vi.fn(async () => {}), saveRequestDetail: persistence.saveRequestDetail, saveRequestUsage: persistence.saveRequestUsage }));
import { handleNonStreamingResponse, translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const usageMetadata = { promptTokenCount: 500000, candidatesTokenCount: 100, thoughtsTokenCount: 30, totalTokenCount: 500130, cachedContentTokenCount: 400000 };
function gemini(finishReason = "STOP", tool = false) {
  return { response: { modelVersion: "actual-upstream-model", responseId: "own-diagnostic", candidates: [{ finishReason, content: { role: "model", parts: tool ? [{ functionCall: { id: "upstream-call", name: "capture_context", args: { value: 17 } } }] : [{ text: "answer" }, { thought: true, text: "reasoning" }] } }], usageMetadata } };
}
function argsFor(upstream, sourceFormat = FORMATS.OPENAI_RESPONSES, targetFormat = FORMATS.ANTIGRAVITY) {
  return { providerResponse: Response.json(upstream), provider: "test-provider", model: "requested-route-model", sourceFormat, targetFormat,
    body: { model: "requested-alias", messages: [] }, stream: false, translatedBody: {}, finalBody: {}, requestStartTime: Date.now(), connectionId: "test",
    clientRawRequest: { endpoint: "/v1/responses", body: {} }, reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    trackDone: vi.fn(), appendLog: vi.fn(), universalToolsMode: "off" };
}

describe("native JSON provider responses to client Responses fidelity", () => {
  beforeEach(() => vi.clearAllMocks());
  it("normalizes Gemini input, output thinking, cached usage and actual model", () => {
    const response = translateNonStreamingResponse(gemini(), FORMATS.ANTIGRAVITY, FORMATS.OPENAI);
    expect(response.model).toBe("actual-upstream-model");
    expect(response.usage).toEqual({ prompt_tokens: 500000, completion_tokens: 130, total_tokens: 500130,
      prompt_tokens_details: { cached_tokens: 400000 }, completion_tokens_details: { reasoning_tokens: 30 } });
  });
  it("does not invent an actual upstream model when modelVersion is absent", () => {
    const upstream = gemini(); delete upstream.response.modelVersion;
    expect(translateNonStreamingResponse(upstream, FORMATS.ANTIGRAVITY, FORMATS.OPENAI).model).toBe("unknown");
  });
  it("maps native MAX_TOKENS and safety to length/filter even when tools are present", () => {
    expect(translateNonStreamingResponse(gemini("MAX_TOKENS", true), FORMATS.ANTIGRAVITY, FORMATS.OPENAI).choices[0].finish_reason).toBe("length");
    expect(translateNonStreamingResponse(gemini("SAFETY", true), FORMATS.ANTIGRAVITY, FORMATS.OPENAI).choices[0].finish_reason).toBe("content_filter");
  });
  it("finalizes native Gemini text/reasoning into Responses JSON with usage and telemetry untouched", async () => {
    const upstream = gemini(); const result = await handleNonStreamingResponse(argsFor(upstream));
    const response = await result.response.json();
    expect(response).toMatchObject({ object: "response", status: "completed", model: "actual-upstream-model", incomplete_details: null,
      usage: { input_tokens: 502000, output_tokens: 130, total_tokens: 502130, input_tokens_details: { cached_tokens: 400000 }, output_tokens_details: { reasoning_tokens: 30 } } });
    expect(response.output.find((item) => item.type === "message").content[0].text).toBe("answer");
    expect(response.output.find((item) => item.type === "reasoning").summary[0].text).toBe("reasoning");
    expect(response.choices).toBeUndefined();
    expect(persistence.saveRequestDetail.mock.calls[0][0].providerResponse).toEqual(upstream);
    expect(persistence.saveRequestDetail.mock.calls[0][0].response).toEqual({ content: "answer", thinking: "reasoning", finish_reason: "stop" });
  });
  it.each([FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, FORMATS.CLAUDE])("keeps exhausted native tool replies incomplete for %s", async (format) => {
    const result = await handleNonStreamingResponse(argsFor(gemini("MAX_TOKENS", true), format));
    const response = await result.response.json();
    if (format === FORMATS.OPENAI_RESPONSES) {
      expect(response.status).toBe("incomplete"); expect(response.incomplete_details.reason).toBe("max_output_tokens");
      expect(response.output.find((item) => item.type === "function_call").status).toBe("incomplete");
    } else if (format === FORMATS.OPENAI) expect(response.choices[0].finish_reason).toBe("length");
    else expect(response.stop_reason).toBe("max_tokens");
  });
  it("preserves native Responses status, reasoning and complete usage", async () => {
    const upstream = { id: "resp-native", object: "response", model: "native-model", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "native reasoning" }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 15 } } };
    const response = await (await handleNonStreamingResponse(argsFor(upstream, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES))).response.json();
    expect(response.status).toBe("incomplete"); expect(response.incomplete_details).toEqual(upstream.incomplete_details); expect(response.output).toEqual(upstream.output);
    expect(response.usage).toEqual({ ...upstream.usage, input_tokens: 2010, total_tokens: 2030 });
    expect(persistence.saveRequestDetail.mock.calls[0][0].providerResponse).toEqual(upstream);
  });
  it("does not fabricate zero usage when native Gemini omits measured counts", async () => {
    const upstream = gemini(); delete upstream.response.usageMetadata;
    const response = await (await handleNonStreamingResponse(argsFor(upstream))).response.json();
    expect(response.usage).toBeUndefined(); expect(response.status).toBe("completed");
  });
  it("marks safety-filtered JSON Responses incomplete even with a complete function argument object", async () => {
    const response = await (await handleNonStreamingResponse(argsFor(gemini("SAFETY", true)))).response.json();
    expect(response.status).toBe("incomplete"); expect(response.incomplete_details.reason).toBe("content_filter");
  });
  it("finalizes ordinary OpenAI JSON tool responses while preserving ids and cached/reasoning details", async () => {
    const upstream = { id: "chatcmpl-one", model: "upstream", created: 123, choices: [{ message: { tool_calls: [{ id: "call-existing", function: { name: "capture_context", arguments: '{"value":17}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } };
    const response = await (await handleNonStreamingResponse(argsFor(upstream, FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI))).response.json();
    expect(response.status).toBe("completed");
    expect(response.output[0]).toMatchObject({ type: "function_call", call_id: "call-existing", name: "capture_context", arguments: '{"value":17}' });
    expect(response.usage).toMatchObject({ input_tokens: 2010, output_tokens: 20, total_tokens: 2030, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } });
  });
});
