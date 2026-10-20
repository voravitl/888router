import { beforeEach, describe, expect, it, vi } from "vitest";

// The Gemini client format (/v1beta) is adapted in TWO places that are not the
// open-sse translator layer:
//   - src/app/api/v1beta/models/[...path]/route.js → transformOpenAISSEToGeminiSSE
//   - src/app/api/v1beta/models/[...path]/route.js → convertOpenAIResponseToGemini
// Both only read `content`, so a refusal-only answer arrived as an EMPTY
// candidate. The Gemini part shape has no refusal field — the refusal text has
// to be delivered as a text part.
const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

const REFUSAL = "I can't help with that.";

function makeGeminiRequest(action, body) {
  return new Request(`https://router.test/v1beta/models/test-model:${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
    },
    body: JSON.stringify(body),
  });
}

function sseResponse(events) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function readSse(response) {
  const text = await response.text();
  // The Gemini adapter frames with \r\n\r\n.
  return text
    .split(/\r?\n\r?\n/)
    .filter((block) => block.trim().startsWith("data:"))
    .map((block) => block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

describe("Gemini client format — refusal delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "real-gemini-key",
      connectionId: "gemini-conn",
      connectionName: "Gemini Test",
      providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    mocks.clearAccountError.mockResolvedValue(undefined);
  });

  it("delivers a refusal-only streamed answer as a Gemini text part", async () => {
    mocks.handleChat.mockResolvedValue(
      sseResponse([
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "upstream-model",
          choices: [{ index: 0, delta: { refusal: REFUSAL, role: "assistant" }, finish_reason: "stop" }],
        },
      ])
    );

    const response = await POST(
      makeGeminiRequest("streamGenerateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      { params: Promise.resolve({ path: ["test-model:streamGenerateContent"] }) }
    );

    expect(response.status).toBe(200);
    const chunks = await readSse(response);
    const texts = chunks.flatMap((c) => (c.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean));
    expect(texts).toContain(REFUSAL);
  });

  it("delivers a refusal-only non-streamed answer as a Gemini text part", async () => {
    mocks.handleChat.mockResolvedValue(
      Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1700000000,
        model: "upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, refusal: REFUSAL },
            finish_reason: "stop",
          },
        ],
      })
    );

    const response = await POST(
      makeGeminiRequest("generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      { params: Promise.resolve({ path: ["test-model:generateContent"] }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const texts = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean);
    expect(texts).toContain(REFUSAL);
  });

  it("keeps a normal answer intact and does not duplicate it", async () => {
    mocks.handleChat.mockResolvedValue(
      sseResponse([
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "upstream-model",
          choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "upstream-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ])
    );

    const response = await POST(
      makeGeminiRequest("streamGenerateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      { params: Promise.resolve({ path: ["test-model:streamGenerateContent"] }) }
    );

    const chunks = await readSse(response);
    const texts = chunks.flatMap((c) => (c.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean));
    expect(texts).toEqual(["hello"]);
  });
});
