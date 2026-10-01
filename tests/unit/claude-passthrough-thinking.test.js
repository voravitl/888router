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

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CLAUDE_HEADERS = {
  "user-agent": "claude-cli/2.1.92 (external, cli)",
  "x-app": "cli",
};

async function runPassthrough(model) {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  await handleChatCore({
    body: {
      model,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    },
    modelInfo: { provider: "claude", model },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log,
    connectionId: "test-conn",
    providerThinking: { mode: "max" },
    sourceFormatOverride: "claude",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: {},
      headers: CLAUDE_HEADERS,
    },
  });
  return { log, sentBody: executeMock.mock.calls[0][0].body };
}

describe("handleChatCore claude passthrough thinking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      transformedBody: null,
    });
  });

  it("sonnet-5 keeps adaptive thinking with injected max effort, no reasoning keys", async () => {
    const { log, sentBody } = await runPassthrough("claude-sonnet-5");
    expect(log.debug).toHaveBeenCalledWith("PASSTHROUGH", expect.stringContaining("native lossless"));
    expect(sentBody).not.toHaveProperty("reasoning_effort");
    expect(sentBody).not.toHaveProperty("reasoning");
    expect(sentBody.thinking).toEqual({ type: "adaptive" });
    expect(sentBody.output_config).toEqual({ effort: "max" });
  });

  it.each([
    "claude-sonnet-4-6",
    "claude-sonnet-4.6",
    "claude-opus-4-6",
    "claude-opus-4.6",
  ])("passthrough %s falls back injected max effort to high (no max support)", async (model) => {
    const { sentBody } = await runPassthrough(model);
    expect(sentBody.thinking).toEqual({ type: "adaptive" });
    expect(sentBody.output_config).toEqual({ effort: "high" });
  });

  it.each([
    "claude-sonnet-4-6(max)",
    "claude-opus-4.6(max)",
  ])("passthrough suffix %s falls back max to high", async (model) => {
    const { sentBody } = await runPassthrough(model, { providerThinking: null, thinking: null });
    expect(sentBody.thinking).toEqual({ type: "adaptive" });
    expect(sentBody.output_config).toEqual({ effort: "high" });
  });

  it.each([
    "claude-sonnet-5",
    "claude-opus-5-5",
  ])("passthrough %s keeps injected max effort", async (model) => {
    const { sentBody } = await runPassthrough(model);
    expect(sentBody.thinking).toEqual({ type: "adaptive" });
    expect(sentBody.output_config).toEqual({ effort: "max" });
  });

  it("passthrough claude-fable-5-1 keeps max effort without a redundant thinking switch", async () => {
    // Fable is permanently adaptive (thinkingCanDisable: false): no thinking
    // switch on the wire, effort travels in output_config only.
    const { sentBody } = await runPassthrough("claude-fable-5-1");
    expect(sentBody.thinking).toBeUndefined();
    expect(sentBody.output_config).toEqual({ effort: "max" });
  });

  it("haiku downgrades adaptive to enabled+budget, no reasoning keys", async () => {
    const { log, sentBody } = await runPassthrough("claude-haiku-4.5");
    expect(log.debug).toHaveBeenCalledWith("PASSTHROUGH", expect.stringContaining("native lossless"));
    expect(sentBody).not.toHaveProperty("reasoning_effort");
    expect(sentBody).not.toHaveProperty("reasoning");
    expect(sentBody.thinking.type).not.toBe("adaptive");
    expect(sentBody.thinking.type).toBe("enabled");
    expect(sentBody.thinking.budget_tokens).toEqual(expect.any(Number));
  });
});
