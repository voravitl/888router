import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    COLORS: { red: "", reset: "" },
    createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
    createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  };
});

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (mimeType, base64) => `data:${mimeType};base64,${base64}`,
  parseDataUri: (url) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    return m ? { mimeType: m[1], base64: m[2] } : null;
  },
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
import opencodeGoConfig from "../../open-sse/providers/registry/opencode-go.js";
import opencodeConfig from "../../open-sse/providers/registry/opencode.js";

describe("OpenCode tool cap configuration & execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      url: "https://opencode.ai/zen/go/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("opencode-go registry defines maxTools: 128", () => {
    expect(opencodeGoConfig.maxTools).toBe(128);
    expect(PROVIDERS["opencode-go"]?.maxTools).toBe(128);
  });

  it("opencode registry defines maxTools: 128", () => {
    expect(opencodeConfig.maxTools).toBe(128);
    expect(PROVIDERS["opencode"]?.maxTools).toBe(128);
  });

  it("caps 219 Claude tools down to 128 when routing to opencode-go", async () => {
    const tools = Array.from({ length: 219 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Description ${i}`,
      input_schema: { type: "object", properties: { x: { type: "string" } } },
    }));

    const body = {
      model: "opencode-go/deepseek-v4.1-flash",
      stream: false,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      tools,
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
      credentials: { apiKey: "test-key" },
      connectionId: "test-conn",
      sourceFormatOverride: "claude",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    const upstreamBody = callArgs.body;
    expect(upstreamBody.tools).toBeDefined();
    expect(upstreamBody.tools.length).toBe(128);
    expect(upstreamBody.tools[0].function.name).toBe("tool_0");
    expect(upstreamBody.tools[127].function.name).toBe("tool_127");
  });

  it("caps tools down to 128 for generic openai target format even if provider omitted maxTools", async () => {
    const tools = Array.from({ length: 150 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Description ${i}`,
      input_schema: { type: "object", properties: {} },
    }));

    const body = {
      model: "openai/gpt-5.4",
      stream: false,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      tools,
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-5.4" },
      credentials: { apiKey: "test-key" },
      connectionId: "test-conn",
      sourceFormatOverride: "claude",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    const upstreamBody = callArgs.body;
    expect(upstreamBody.tools).toBeDefined();
    expect(upstreamBody.tools.length).toBe(128);
  });

  it("preserves xai custom maxTools of 250 instead of falling back to 128", async () => {
    const tools = Array.from({ length: 260 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Description ${i}`,
      input_schema: { type: "object", properties: {} },
    }));

    const body = {
      model: "xai/grok-4.7",
      stream: false,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      tools,
    };

    await handleChatCore({
      body,
      modelInfo: { provider: "xai", model: "grok-4.7" },
      credentials: { apiKey: "test-key" },
      connectionId: "test-conn",
      sourceFormatOverride: "claude",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0][0];
    const upstreamBody = callArgs.body;
    expect(upstreamBody.tools).toBeDefined();
    expect(upstreamBody.tools.length).toBe(250);
  });
});
