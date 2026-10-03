import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: persistence.saveRequestDetail,
  saveRequestUsage: persistence.saveRequestUsage,
}));

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const providerUsage = { prompt_tokens: 500000, completion_tokens: 30, total_tokens: 500030,
  prompt_tokens_details: { cached_tokens: 400000 }, completion_tokens_details: { reasoning_tokens: 10 } };

function argsFor(responseBody, targetFormat) {
  return {
    providerResponse: Response.json(responseBody), provider: "test-provider", model: "actual-model",
    sourceFormat: FORMATS.GEMINI, targetFormat, body: { model: "test-model", contents: [] },
    stream: false, translatedBody: {}, finalBody: {}, requestStartTime: Date.now(), connectionId: "test",
    clientRawRequest: { endpoint: "/v1beta/models/test:generateContent", body: {} },
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
    trackDone: vi.fn(), appendLog: vi.fn(), universalToolsMode: "off",
  };
}

describe("real non-streaming response pipeline for Gemini clients", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves OpenAI usage for endpoint adaptation while recording unmodified upstream counts", async () => {
    const upstream = { id: "chatcmpl-real", model: "actual-model", choices: [{ index: 0,
      message: { role: "assistant", content: "long context response" }, finish_reason: "stop" }], usage: providerUsage };
    const args = argsFor(upstream, FORMATS.OPENAI);
    const result = await handleNonStreamingResponse(args);
    expect(result.success).toBe(true);
    const response = await result.response.json();
    expect(response.choices[0].message.content).toBe("long context response");
    // Legacy client-facing safety padding is separate from provider telemetry.
    expect(response.usage).toEqual({ ...providerUsage, prompt_tokens: 502000, total_tokens: 502030 });
    expect(args.reqLogger.logProviderResponse.mock.calls[0][3].usage).toEqual(providerUsage);
    const detail = persistence.saveRequestDetail.mock.calls[0][0];
    expect(detail.providerResponse.usage).toEqual(providerUsage);
    expect(detail.tokens.prompt_tokens).toBe(500000);
    expect(detail.tokens.cached_tokens).toBe(400000);
  });

  it.each([
    [FORMATS.CLAUDE, { id: "msg-real", model: "actual-model", content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn", usage: { input_tokens: 500000, output_tokens: 30 } }],
    [FORMATS.OPENAI_RESPONSES, { id: "resp-real", model: "actual-model", output: [{ type: "message",
      content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 500000, output_tokens: 30 } }],
  ])("keeps translated %s token counts available to the Gemini adapter", async (targetFormat, upstream) => {
    const result = await handleNonStreamingResponse(argsFor(upstream, targetFormat));
    const response = await result.response.json();
    expect(response.choices[0].message.content).toBe("answer");
    expect(response.usage).toEqual({ prompt_tokens: 502000, completion_tokens: 30, total_tokens: 502030 });
    expect(persistence.saveRequestDetail.mock.calls[0][0].tokens.prompt_tokens).toBe(500000);
  });

  it("preserves native Gemini usageMetadata without applying OpenAI filtering or padding", async () => {
    const usageMetadata = { promptTokenCount: 500000, candidatesTokenCount: 30, totalTokenCount: 500030,
      cachedContentTokenCount: 400000 };
    const result = await handleNonStreamingResponse(argsFor({ candidates: [{ content: { role: "model",
      parts: [{ text: "native answer" }] }, finishReason: "STOP" }], usageMetadata }, FORMATS.GEMINI));
    expect((await result.response.json()).usageMetadata).toEqual(usageMetadata);
    expect(persistence.saveRequestDetail.mock.calls[0][0].tokens.prompt_tokens).toBe(500000);
  });
});
