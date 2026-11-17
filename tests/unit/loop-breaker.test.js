import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  handleChatCoreMock: vi.fn(),
  getModelInfoMock: vi.fn(),
  getProviderCredentialsMock: vi.fn(),
  checkAndRefreshTokenMock: vi.fn(),
  getComboModelsMock: vi.fn(),
}));

describe("Runaway Loop Circuit Breaker (open-sse/utils/loopBreaker.js + chat.js)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.LOOP_BREAKER;
  });

  afterEach(() => {
    delete process.env.LOOP_BREAKER;
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("open-sse/handlers/chatCore.js");
    vi.doUnmock("../../src/sse/services/model.js");
    vi.doUnmock("../../src/sse/services/auth.js");
    vi.doUnmock("../../src/sse/services/tokenRefresh.js");
    vi.doUnmock("../../src/sse/services/modelContext.js");
    vi.doUnmock("../../src/sse/services/providerQuota.js");
  });

  it("allows varied tool calls and interleaved edits without false positives", async () => {
    const { detectRunawayLoop, clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();

    // 6 varied grep calls with different queries
    const variedMessages = [];
    for (let i = 0; i < 6; i++) {
      variedMessages.push({
        role: "assistant",
        tool_calls: [{ id: `t${i}`, type: "function", function: { name: "grep", arguments: JSON.stringify({ q: `sym${i}` }) } }],
      });
      variedMessages.push({ role: "tool", tool_call_id: `t${i}`, content: `match sym${i}` });
    }
    expect(detectRunawayLoop({ body: { messages: variedMessages }, headers: {} }).tripped).toBe(false);

    // Interleaved Read -> Edit -> Read -> Edit -> Read -> Edit -> Read
    const interleaved = [];
    for (let i = 0; i < 4; i++) {
      interleaved.push(
        { role: "assistant", tool_calls: [{ id: `r${i}`, function: { name: "Read", arguments: '{"file":"a.js"}' } }] },
        { role: "tool", tool_call_id: `r${i}`, content: "code" },
        { role: "assistant", tool_calls: [{ id: `e${i}`, function: { name: "Edit", arguments: '{"file":"a.js","line":1}' } }] },
        { role: "tool", tool_call_id: `e${i}`, content: "ok" },
      );
    }
    expect(detectRunawayLoop({ body: { messages: interleaved }, headers: {} }).tripped).toBe(false);
  });

  it("trips on >= 5 consecutive identical trailing tool calls (OpenAI & Claude shapes)", async () => {
    const { detectRunawayLoop, clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();

    // OpenAI shape
    const oaiMsgs = [{ role: "user", content: "fix the build" }];
    for (let i = 0; i < 5; i++) {
      oaiMsgs.push({
        role: "assistant",
        tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }],
      });
      oaiMsgs.push({ role: "tool", tool_call_id: `call_${i}`, content: "passed" });
    }
    const oaiVerdict = detectRunawayLoop({ body: { messages: oaiMsgs }, headers: {} });
    expect(oaiVerdict.tripped).toBe(true);
    expect(oaiVerdict.reason).toBe("identical_tool_loop");
    expect(oaiVerdict.streak).toBeGreaterThanOrEqual(5);

    // Claude tool_use shape
    const claudeMsgs = [{ role: "user", content: "fix it" }];
    for (let i = 0; i < 5; i++) {
      claudeMsgs.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `tu_${i}`, name: "Read", input: { file_path: "/app/x.js" } }],
      });
      claudeMsgs.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "line 1\nline 2" }],
      });
    }
    const claudeVerdict = detectRunawayLoop({ body: { messages: claudeMsgs }, headers: {} });
    expect(claudeVerdict.tripped).toBe(true);
    expect(claudeVerdict.reason).toBe("identical_tool_loop");
  });

  it("trips on >= 4 consecutive identical tool error outputs even when args vary slightly", async () => {
    const { detectRunawayLoop, clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();

    const messages = [{ role: "user", content: "deploy" }];
    for (let i = 0; i < 4; i++) {
      messages.push({
        role: "assistant",
        tool_calls: [{ id: `c${i}`, function: { name: "bash", arguments: JSON.stringify({ attempt: i + 1 }) } }],
      });
      messages.push({
        role: "tool",
        tool_call_id: `c${i}`,
        content: `Error: ECONNREFUSED 127.0.0.1:5432 failed after ${100 + i}ms (req_id=abc-${i})`,
      });
    }
    const verdict = detectRunawayLoop({ body: { messages }, headers: {} });
    expect(verdict.tripped).toBe(true);
    expect(verdict.reason).toBe("identical_error_loop");
  });

  it("trips on >= 6 rapid identical session-burst requests with tool history, but ignores repeated short ping probes", async () => {
    const { detectRunawayLoop, clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();

    // Health check "ping" probes (no tools, <= 2 msgs) must never trip
    const pingReq = {
      headers: { "x-session-id": "health-probe-1" },
      body: { model: "openai/gpt-5", messages: [{ role: "user", content: "ping" }] },
    };
    for (let i = 0; i < 8; i++) {
      expect(detectRunawayLoop(pingReq).tripped).toBe(false);
    }

    // Identical stalled tool-loop payload re-sent 6 times in same session trips
    const loopPayload = {
      headers: { "x-hermes-session-id": "hermes-stuck-99" },
      body: {
        model: "ocg/deepseek-v4.1-flash",
        messages: [
          { role: "user", content: "check repo" },
          { role: "assistant", tool_calls: [{ id: "1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
          { role: "tool", tool_call_id: "1", content: "Permission denied" },
        ],
      },
    };
    for (let i = 0; i < 5; i++) {
      expect(detectRunawayLoop(loopPayload).tripped).toBe(false);
    }
    const burst = detectRunawayLoop(loopPayload);
    expect(burst.tripped).toBe(true);
    expect(burst.reason).toBe("session_burst_loop");
  });

  it("resets trailing streak at Responses API input_text user turns", async () => {
    const { detectRunawayLoop, clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();

    const input = [];
    for (let i = 0; i < 4; i++) {
      input.push({ type: "function_call", name: "bash", arguments: '{"cmd":"pwd"}' });
      input.push({ type: "function_call_output", output: "/app" });
    }
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "check one more time" }] });
    input.push({ type: "function_call", name: "bash", arguments: '{"cmd":"pwd"}' });
    input.push({ type: "function_call_output", output: "/app" });

    expect(detectRunawayLoop({ body: { input }, headers: {} }).tripped).toBe(false);
  });

  const setupLoopBreakerChatMocks = async () => {
    vi.doMock("@/lib/localDb", () => ({
      getSettings: mocks.getSettings,
      updateProviderConnection: vi.fn(async () => {}),
      getProviderConnections: vi.fn(async () => []),
    }));
    vi.doMock("open-sse/handlers/chatCore.js", () => ({
      handleChatCore: mocks.handleChatCoreMock,
    }));
    vi.doMock("../../src/sse/services/model.js", () => ({
      getModelInfo: mocks.getModelInfoMock,
      getComboModels: mocks.getComboModelsMock,
      applyThinkingSuffixToMembers: (m) => m,
    }));
    vi.doMock("../../src/sse/services/auth.js", () => ({
      getProviderCredentials: mocks.getProviderCredentialsMock,
      markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
      clearAccountError: vi.fn(async () => {}),
      extractApiKey: vi.fn(() => null),
      isValidApiKey: vi.fn(async () => true),
    }));
    vi.doMock("../../src/sse/services/tokenRefresh.js", () => ({
      updateProviderCredentials: vi.fn(async () => {}),
      checkAndRefreshToken: mocks.checkAndRefreshTokenMock,
    }));
    vi.doMock("../../src/sse/services/modelContext.js", () => ({
      ensureModelContextLoaded: vi.fn(async () => {}),
    }));
    vi.doMock("../../src/sse/services/providerQuota.js", () => ({
      clearProviderStrikes: vi.fn(),
      handleProviderQuotaError: vi.fn(async () => null),
      isQuotaTrackedProvider: vi.fn(() => false),
    }));

    const { clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearLoopBreakerStore();
    return await import("../../src/sse/handlers/chat.js");
  };

  it("chat.js short-circuits tripped loops with 400 loop_detected before invoking handleChatCore or combo rotation", async () => {
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      rtkEnabled: true,
      loopBreakerEnabled: true,
      sessionAffinityEnabled: true,
    });
    mocks.getComboModelsMock.mockResolvedValue(["openai/gpt-5"]);
    mocks.getModelInfoMock.mockResolvedValue({ provider: "openai", model: "gpt-5" });
    mocks.getProviderCredentialsMock.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "openai-1",
      apiKey: "sk-test",
      providerSpecificData: {},
    });
    mocks.checkAndRefreshTokenMock.mockImplementation(async (_p, creds) => creds);
    mocks.handleChatCoreMock.mockResolvedValue({
      success: true,
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const { handleChat } = await setupLoopBreakerChatMocks();

    const messages = [{ role: "user", content: "loop" }];
    for (let i = 0; i < 5; i++) {
      messages.push({
        role: "assistant",
        tool_calls: [{ id: `c_${i}`, function: { name: "bash", arguments: '{"cmd":"cat missing.txt"}' } }],
      });
      messages.push({ role: "tool", tool_call_id: `c_${i}`, content: "ENOENT" });
    }

    const res = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "HermesAgent/0.14.0" },
      body: JSON.stringify({ model: "9-opus", messages }),
    }));

    expect(res.status).toBe(400);
    expect(res.headers.get("X-888-Loop-Breaker")).toBe("tripped");
    const json = await res.json();
    expect(json.error?.code).toBe("loop_detected");
    expect(mocks.handleChatCoreMock).not.toHaveBeenCalled();

    // Respects loopBreakerEnabled: false
    mocks.getSettings.mockResolvedValueOnce({
      requireApiKey: false,
      loopBreakerEnabled: false,
    });
    const allowed = await handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5", messages }),
    }));
    expect(allowed.status).toBe(200);
    expect(mocks.handleChatCoreMock).toHaveBeenCalledOnce();
  });

  it("chat.js skips Loop Breaker for Claude Code bypass warmup and naming requests, and formats Claude /v1/messages errors cleanly", async () => {
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      ccFilterNaming: true,
      loopBreakerEnabled: true,
      sessionAffinityEnabled: true,
    });
    mocks.getComboModelsMock.mockResolvedValue(null);
    mocks.getModelInfoMock.mockResolvedValue({ provider: "claude", model: "claude-sonnet-5-5" });
    mocks.getProviderCredentialsMock.mockResolvedValue({
      connectionId: "conn-1",
      connectionName: "claude-1",
      apiKey: "sk-test",
      providerSpecificData: {},
    });
    mocks.checkAndRefreshTokenMock.mockImplementation(async (_p, creds) => creds);

    const { handleChat } = await setupLoopBreakerChatMocks();

    const repeatedCalls = [];
    for (let i = 0; i < 5; i++) {
      repeatedCalls.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `tu_${i}`, name: "Bash", input: { cmd: "ls" } }],
      });
      repeatedCalls.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: "ok" }],
      });
    }

    // Warmup bypass must return 200 without tripping Loop Breaker
    const warmupRes = await handleChat(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.92" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        stream: false,
        messages: [{ role: "user", content: "Warmup" }, ...repeatedCalls],
      }),
    }));
    expect(warmupRes.status).toBe(200);
    expect(warmupRes.headers.get("X-888-Loop-Breaker")).toBeNull();

    // Naming bypass (ccFilterNaming + isNewTopic) must return 200 without tripping Loop Breaker
    const namingRes = await handleChat(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.92" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        stream: false,
        system: "Analyze if this message indicates a new conversation topic (isNewTopic).",
        messages: [{ role: "user", content: "fix auth flow" }, ...repeatedCalls],
      }),
    }));
    expect(namingRes.status).toBe(200);
    expect(namingRes.headers.get("X-888-Loop-Breaker")).toBeNull();
    expect(mocks.handleChatCoreMock).not.toHaveBeenCalled();

    // Real Claude /v1/messages loop trips with Anthropic error envelope
    const claudeLoopRes = await handleChat(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "claude-cli/2.1.92" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        stream: false,
        messages: [{ role: "user", content: "fix auth flow" }, ...repeatedCalls],
      }),
    }));
    expect(claudeLoopRes.status).toBe(400);
    expect(claudeLoopRes.headers.get("X-888-Loop-Breaker")).toBe("tripped");
    const claudeJson = await claudeLoopRes.json();
    expect(claudeJson.type).toBe("error");
    expect(claudeJson.error?.type).toBe("invalid_request_error");
    expect(mocks.handleChatCoreMock).not.toHaveBeenCalled();
  });
});
