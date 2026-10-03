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
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
  createClaudeNativeStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CLAUDE_HEADERS = {
  "user-agent": "claude-cli/2.1.92 (external, cli)",
  "x-app": "cli",
  "x-888-native-transformations": "true",
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
    expect(log.debug).toHaveBeenCalledWith("PASSTHROUGH", expect.stringContaining("native transformed"));
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
    expect(log.debug).toHaveBeenCalledWith("PASSTHROUGH", expect.stringContaining("native transformed"));
    expect(sentBody).not.toHaveProperty("reasoning_effort");
    expect(sentBody).not.toHaveProperty("reasoning");
    expect(sentBody.thinking.type).not.toBe("adaptive");
    expect(sentBody.thinking.type).toBe("enabled");
    expect(sentBody.thinking.budget_tokens).toEqual(expect.any(Number));
  });

  it("preserves Claude's native request by default despite enabled router transforms", async () => {
    const body = {
      model: "claude-sonnet-5",
      stream: false,
      system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "prior hidden reasoning", signature: "opaque-history-signature" }, { type: "text", text: "prior answer" }] },
        { role: "user", content: [{ type: "text", text: "keep this exact", cache_control: { type: "ephemeral" } }] },
      ],
      thinking: { type: "adaptive", effort: "high", signature: "opaque-thinking-state" },
      output_config: { effort: "medium" },
      tools: [
        { name: "Read", description: "built in", input_schema: { type: "object" } },
        { name: "mcp__Read", description: "same action", input_schema: { type: "object" } },
      ],
      tool_choice: { type: "auto" },
      metadata: { user_id: "session-123" },
      temperature: 0.2,
      _pruned: "caller extension",
    };
    const expected = structuredClone(body);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: body.model },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      providerThinking: { mode: "max" },
      sourceFormatOverride: "claude",
      rtkEnabled: true,
      prunerEnabled: true,
      headroomEnabled: true,
      headroomUrl: "http://headroom:8787",
      cavemanEnabled: true,
      cavemanLevel: "lite",
      ponytailEnabled: true,
      ponytailLevel: "lite",
      universalToolsMode: "on",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: { "user-agent": "claude-cli/2.1.92 (external, cli)", "x-app": "cli" },
      },
    });

    expected.model = "claude-sonnet-5";
    expect(executeMock.mock.calls[0][0].body).toEqual(expected);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body).toEqual(expected);
    expect(log.debug).toHaveBeenCalledWith("PASSTHROUGH", expect.stringContaining("native faithful"));
  });

  it("keeps optional Claude client transforms off for translated combo leaves", async () => {
    const largeToolOutput = `important output ${"repeat this exact result ".repeat(40)}`;
    await handleChatCore({
      body: {
        model: "claude-sonnet-5",
        stream: false,
        system: "retain the caller's instruction",
        messages: [{
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: largeToolOutput }],
        }],
        tools: [
          { name: "Read", description: "builtin", input_schema: { type: "object" } },
          { name: "mcp__Read", description: "same action", input_schema: { type: "object" } },
        ],
        thinking: { type: "adaptive" },
      },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      credentials: { apiKey: "upstream-key", providerSpecificData: {} },
      connectionId: "combo-openai-leaf",
      providerThinking: { mode: "high" },
      sourceFormatOverride: "claude",
      rtkEnabled: true,
      prunerEnabled: true,
      headroomEnabled: true,
      headroomUrl: "http://headroom:8787",
      cavemanEnabled: true,
      cavemanLevel: "lite",
      ponytailEnabled: true,
      ponytailLevel: "lite",
      universalToolsMode: "off",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: { "user-agent": "claude-cli/2.1.92 (external, cli)", "x-app": "cli" },
      },
    });

    const sentBody = executeMock.mock.calls[0][0].body;
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sentBody.tools).toHaveLength(2);
    expect(sentBody.messages.find(message => message.role === "tool")?.content).toBe(largeToolOutput);
    expect(sentBody.messages[0].content).toBe("retain the caller's instruction");
    expect(sentBody.messages.some(message => JSON.stringify(message).includes("Caveman"))).toBe(false);
    expect(sentBody).not.toHaveProperty("reasoning_effort");
  });

  it("isolates session headers and upstream auth across interleaved native Claude requests", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const { cacheClaudeHeaders } = await import("../../open-sse/utils/claudeHeaderCache.js");
    const executor = new DefaultExecutor("claude");
    cacheClaudeHeaders({ "user-agent": "claude-cli/old", "x-app": "cli", "x-claude-code-session-id": "stale-session", "anthropic-beta": "stale-beta" });

    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const capturedHeaders = new Map();
    let callCount = 0;
    executeMock.mockImplementation(async ({ credentials, stream, model }) => {
      const sessionId = credentials.rawHeaders["x-claude-code-session-id"];
      capturedHeaders.set(sessionId, executor.buildHeaders(
        credentials,
        stream,
        "https://api.anthropic.com/v1/messages",
        model,
      ));
      callCount++;
      if (callCount === 1) await firstGate;
      return {
        response: new Response(JSON.stringify({
          id: `message-${sessionId}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "content-type": "application/json" } }),
        url: "https://api.anthropic.com/v1/messages",
        headers: {},
        transformedBody: null,
      };
    });

    const send = (name, sessionId, beta) => handleChatCore({
      body: { model: "claude-sonnet-5", stream: false, messages: [{ role: "user", content: name }] },
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { apiKey: `provider-${name}`, providerSpecificData: {} },
      connectionId: name,
      sourceFormatOverride: "claude",
      providerThinking: { mode: "max" },
      headroomEnabled: false,
      rtkEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: {
          "user-agent": `claude-cli/${name}`,
          "x-app": "cli",
          "x-claude-code-session-id": sessionId,
          "anthropic-beta": beta,
          authorization: `Bearer client-${name}`,
          "x-api-key": `client-${name}`,
        },
      },
    });

    const firstRequest = send("first", "session-first", "beta-first");
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    const secondRequest = send("second", "session-second", "beta-second");
    await secondRequest;
    releaseFirst();
    await firstRequest;

    const firstHeaders = capturedHeaders.get("session-first");
    const secondHeaders = capturedHeaders.get("session-second");
    expect(firstHeaders["x-claude-code-session-id"]).toBe("session-first");
    expect(firstHeaders["anthropic-beta"]).toBe("beta-first");
    expect(firstHeaders["x-api-key"]).toBe("provider-first");
    expect(firstHeaders.Authorization).toBeUndefined();
    expect(secondHeaders["x-claude-code-session-id"]).toBe("session-second");
    expect(secondHeaders["anthropic-beta"]).toBe("beta-second");
    expect(secondHeaders["x-api-key"]).toBe("provider-second");
    expect(secondHeaders.Authorization).toBeUndefined();
    expect(firstHeaders["x-claude-code-session-id"]).not.toBe("stale-session");
    expect(secondHeaders["anthropic-beta"]).not.toContain("stale-beta");
  });
});
