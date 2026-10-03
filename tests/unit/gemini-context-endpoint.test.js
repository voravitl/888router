import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handleChat: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("@/sse/services/auth.js", () => ({
  clearAccountError: vi.fn(), getProviderCredentials: vi.fn(), isValidApiKey: vi.fn(), markAccountUnavailable: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn() }));
const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

function request(path, body, signal) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" }, body: JSON.stringify(body), signal,
  });
}
function post(path, body, signal) {
  return POST(request(path, body, signal), { params: Promise.resolve({ path: path.split("/") }) });
}
function streamResponse(events, fragmentSize = 17) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += fragmentSize) controller.enqueue(bytes.slice(index, index + fragmentSize));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
function eventsFrom(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((event) => JSON.parse(event.slice(6)));
}

describe("Gemini context endpoint fidelity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleChat.mockResolvedValue(Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], modelVersion: "actual-model" }));
  });

  it("preserves large native contents, tools, function history, media and extensions for shared translation", async () => {
    const body = {
      systemInstruction: { parts: [{ text: "Keep instructions." }] },
      contents: [
        { role: "model", parts: [{ functionCall: { name: "lookup", args: { id: 17 } }, thoughtSignature: "opaque-signature" }] },
        { role: "user", parts: [{ functionResponse: { name: "lookup", response: { result: "found" } } }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }, { fileData: { mimeType: "application/pdf", fileUri: "gs://test/document" } }, { text: `START_MARKER\n${"ภาษาไทย reference 🌏\n".repeat(100000)}END_MARKER` }] },
      ],
      tools: [{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT", properties: { id: { type: "INTEGER" } } } }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 128 } },
      cachedContent: "cachedContents/test", futureExtension: { preserve: true },
    };
    await post("gemini/gemini-context-model:generateContent", body);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(await forwarded.json()).toEqual({ ...body, model: "gemini/gemini-context-model", stream: false });
    expect(forwarded.headers.get("Authorization")).toBe("Bearer test-key");
  });

  it("retains every provider/model path segment and only strips the trailing action", async () => {
    await post("custom/google/nested-model:generateContent", { contents: [{ parts: [{ text: "hello" }] }] });
    expect((await mocks.handleChat.mock.calls[0][0].json()).model).toBe("custom/google/nested-model");
  });

  it("takes streaming intent from URL and forwards caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.handleChat.mockResolvedValue(streamResponse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]));
    const response = await post("gemini/model:streamGenerateContent", { contents: [], stream: false, generationConfig: { stream: false } }, controller.signal);
    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect((await forwarded.json()).stream).toBe(true);
    expect(forwarded.signal.aborted).toBe(true);
    await response.text();
  });

  it("preserves native streamed candidates, function calls, signatures and usage across byte boundaries", async () => {
    const native = { candidates: [{ content: { parts: [{ text: "ไทย 🌏" }, { functionCall: { name: "lookup", args: { id: 17 } }, thoughtSignature: "opaque" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500000 }, modelVersion: "native-model" };
    mocks.handleChat.mockResolvedValue(streamResponse([native], 1));
    const response = await post("gemini/model:streamGenerateContent", { contents: [] });
    expect(eventsFrom(await response.text())).toEqual([native]);
  });

  it("reconstructs translated streamed tool calls without dropping fragmented frames or usage-only events", async () => {
    mocks.handleChat.mockResolvedValue(streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: '{"id":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "17}" } }] }, finish_reason: null }] },
      { model: "selected-leaf", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 500000, completion_tokens: 10, total_tokens: 500010, prompt_tokens_details: { cached_tokens: 450000 } } },
      "[DONE]",
    ], 3));
    const response = await post("custom/model:streamGenerateContent", { contents: [] });
    const parsed = eventsFrom(await response.text());
    expect(parsed[0].candidates[0].content.parts).toEqual([{ functionCall: { name: "lookup", args: { id: 17 } } }]);
    expect(parsed[0].modelVersion).toBe("selected-leaf");
    expect(parsed[1].usageMetadata.promptTokenCount).toBe(500000);
    expect(parsed[1].usageMetadata.cachedContentTokenCount).toBe(450000);
  });

  it("fails interrupted translated tool argument streams rather than fabricating a completion", async () => {
    mocks.handleChat.mockResolvedValue(streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: '{"id":' } }] } }] }]));
    const response = await post("custom/model:streamGenerateContent", { contents: [] });
    await expect(response.text()).rejects.toThrow("before completing tool calls");
  });

  it("retains translated non-streaming tool calls and cached usage in Gemini shape", async () => {
    mocks.handleChat.mockResolvedValue(Response.json({ model: "selected-leaf", choices: [{ message: { content: null, tool_calls: [{ function: { name: "lookup", arguments: '{"id":17}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 400000 } } }));
    const response = await post("custom/model:generateContent", { contents: [] });
    const parsed = await response.json();
    expect(parsed.candidates[0].content.parts).toEqual([{ functionCall: { name: "lookup", args: { id: 17 } } }]);
    expect(parsed.modelVersion).toBe("selected-leaf");
    expect(parsed.usageMetadata.cachedContentTokenCount).toBe(400000);
  });

  it("preserves upstream non-success status and error body", async () => {
    mocks.handleChat.mockResolvedValue(Response.json({ error: { message: "capacity exhausted" } }, { status: 429 }));
    const response = await post("custom/model:generateContent", { contents: [] });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "capacity exhausted" } });
  });
});
