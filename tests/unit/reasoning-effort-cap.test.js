import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  executeMock: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  handleChatCoreMock: vi.fn(),
  getModelInfoMock: vi.fn(),
  getProviderCredentialsMock: vi.fn(),
  checkAndRefreshTokenMock: vi.fn(),
  getComboModelsMock: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      });
    },
  },
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: mocks.executeMock,
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

describe("reasoningEffortCap — settingsRepo", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-cap-settings-"));
    process.env.DATA_DIR = tempDir;
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("defaults reasoningEffortCap to 'off' while keeping rtkEnabled and prunerEnabled true", async () => {
    vi.resetModules();
    const db = await import("../../src/lib/db/index.js");
    await db.initDb();
    const settings = await db.getSettings();
    expect(settings.reasoningEffortCap).toBe("off");
    expect(settings.rtkEnabled).toBe(true);
    expect(settings.prunerEnabled).toBe(true);

    const updated = await db.updateSettings({ reasoningEffortCap: "low" });
    expect(updated.reasoningEffortCap).toBe("low");
    const reloaded = await db.getSettings();
    expect(reloaded.reasoningEffortCap).toBe("low");
  });
});

describe("reasoningEffortCap — /api/settings GET & PATCH", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.getSettings.mockResolvedValue({
      reasoningEffortCap: "off",
      universalToolsMode: "auto",
      rtkEnabled: true,
      prunerEnabled: true,
    });
    mocks.updateSettings.mockImplementation(async (patch) => ({
      reasoningEffortCap: "off",
      universalToolsMode: "auto",
      rtkEnabled: true,
      prunerEnabled: true,
      ...patch,
    }));

    vi.doMock("@/lib/localDb", () => ({
      getSettings: mocks.getSettings,
      updateSettings: mocks.updateSettings,
    }));
    vi.doMock("@/lib/network/outboundProxy", () => ({
      applyOutboundProxyEnv: vi.fn(),
    }));
    vi.doMock("open-sse/services/combo.js", () => ({
      resetComboRotation: vi.fn(),
      normalizePersistedStrategy: (s) => s,
    }));
    vi.doMock("@/shared/services/quotaAutoPing", () => ({
      runQuotaAutoPingTick: vi.fn(async () => {}),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("@/lib/network/outboundProxy");
    vi.doUnmock("open-sse/services/combo.js");
    vi.doUnmock("@/shared/services/quotaAutoPing");
  });

  it("returns reasoningEffortCap in GET and accepts 'off' | 'low' | 'medium' in PATCH", async () => {
    const { GET, PATCH } = await import("../../src/app/api/settings/route.js");

    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.reasoningEffortCap).toBe("off");

    for (const cap of ["low", "medium", "off"]) {
      const req = new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningEffortCap: cap }),
      });
      const res = await PATCH(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reasoningEffortCap).toBe(cap);
      expect(mocks.updateSettings).toHaveBeenCalledWith({ reasoningEffortCap: cap });
    }
  });

  it.each(["high", "xhigh", "max", "", null, 123, true])("rejects invalid reasoningEffortCap (%j) with 400", async (invalid) => {
    const { PATCH } = await import("../../src/app/api/settings/route.js");
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoningEffortCap: invalid }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reasoningEffortCap/);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});

describe("reasoningEffortCap — chat.js forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      rtkEnabled: true,
      prunerEnabled: true,
      reasoningEffortCap: "low",
      universalToolsMode: "auto",
    });
    mocks.getComboModelsMock.mockResolvedValue(null);
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
  });

  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("open-sse/handlers/chatCore.js");
    vi.doUnmock("../../src/sse/services/model.js");
    vi.doUnmock("../../src/sse/services/auth.js");
    vi.doUnmock("../../src/sse/services/tokenRefresh.js");
    vi.doUnmock("../../src/sse/services/modelContext.js");
    vi.doUnmock("../../src/sse/services/providerQuota.js");
  });

  it("passes reasoningEffortCap from settings to handleChatCore", async () => {
    const { handleChat } = await import("../../src/sse/handlers/chat.js");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await handleChat(req);
    expect(res.status).toBe(200);
    expect(mocks.handleChatCoreMock).toHaveBeenCalledOnce();
    expect(mocks.handleChatCoreMock.mock.calls[0][0].reasoningEffortCap).toBe("low");
  });
});

describe("reasoningEffortCap — handleChatCore enforcement", () => {
  let handleChatCore;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ handleChatCore } = await import("../../open-sse/handlers/chatCore.js"));
    mocks.executeMock.mockImplementation(async () => ({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.example.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    }));
  });

  async function dispatch(opts) {
    await handleChatCore({
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      rtkEnabled: false,
      prunerEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      ...opts,
    });
    return mocks.executeMock.mock.calls[0][0].body;
  }

  it("does nothing when reasoningEffortCap is 'off'", async () => {
    const sent = await dispatch({
      body: { model: "gpt-5", stream: false, reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "off",
    });
    expect(sent.reasoning_effort).toBe("high");
  });

  it.each([
    ["high", "low", "low"],
    ["xhigh", "low", "low"],
    ["max", "low", "low"],
    ["ultra", "low", "low"],
    ["medium", "low", "low"],
    ["low", "low", "low"],
    ["minimal", "low", "minimal"],
    ["high", "medium", "medium"],
    ["xhigh", "medium", "medium"],
    ["max", "medium", "medium"],
    ["medium", "medium", "medium"],
    ["low", "medium", "low"],
  ])("clamps OpenAI reasoning_effort=%s under cap=%s -> %s", async (input, cap, expected) => {
    const sent = await dispatch({
      body: { model: "gpt-5", stream: false, reasoning_effort: input, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: cap,
    });
    expect(sent.reasoning_effort).toBe(expected);
  });

  it("caps unset reasoning_effort on reasoning-capable models, but leaves non-reasoning models untouched", async () => {
    const reasoningSent = await dispatch({
      body: { model: "gpt-5", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "low",
    });
    expect(reasoningSent.reasoning_effort).toBe("low");

    mocks.executeMock.mockClear();
    const nonReasoningSent = await dispatch({
      body: { model: "gpt-4o", stream: false, messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "low",
    });
    expect(nonReasoningSent.reasoning_effort).toBeUndefined();
  });

  it("respects explicit off ('none' / 'off' / disabled) even when cap is 'low'", async () => {
    const sentNone = await dispatch({
      body: { model: "gpt-5", stream: false, reasoning_effort: "none", messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "low",
    });
    expect(sentNone.reasoning_effort).toBe("none");

    mocks.executeMock.mockClear();
    const sentDisabledClaude = await dispatch({
      body: {
        model: "claude-sonnet-4-20250514",
        stream: false,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "claude", model: "claude-sonnet-4-20250514" },
      sourceFormatOverride: "claude",
      reasoningEffortCap: "low",
    });
    expect(sentDisabledClaude.thinking).toEqual({ type: "disabled" });
    expect(sentDisabledClaude.output_config).toBeUndefined();
  });

  it("clamps OpenAI Responses reasoning.effort (passthrough and translated)", async () => {
    const sentCodex = await dispatch({
      body: {
        model: "gpt-5.3-codex",
        stream: false,
        reasoning: { effort: "xhigh", summary: "auto" },
        input: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "codex", model: "gpt-5.3-codex" },
      sourceFormatOverride: "openai-responses",
      clientRawRequest: { endpoint: "/v1/responses", body: {}, headers: { "user-agent": "codex-tui/1.0" } },
      reasoningEffortCap: "medium",
    });
    expect(sentCodex.reasoning?.effort).toBe("medium");
  });

  it("never emits unsupported 'medium' on openai-low-high-max models (pulse-alpha-free)", async () => {
    const sent = await dispatch({
      body: { model: "pulse-alpha-free", stream: false, reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "opencode", model: "pulse-alpha-free" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "medium",
    });
    expect(sent.reasoning_effort).toBe("low");
  });

  it("clamps Claude adaptive output_config.effort without converting thinking.type to 'disabled'", async () => {
    const sentTranslated = await dispatch({
      body: {
        model: "claude-sonnet-5-5",
        stream: false,
        max_tokens: 32768,
        reasoning_effort: "max",
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "claude", model: "claude-sonnet-5-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "medium",
    });
    expect(sentTranslated.thinking).toEqual({ type: "adaptive" });
    expect(sentTranslated.output_config).toEqual({ effort: "medium" });

    mocks.executeMock.mockClear();
    const sentAdaptiveUnsetEffort = await dispatch({
      body: {
        model: "claude-sonnet-5-5",
        stream: false,
        max_tokens: 32768,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "claude", model: "claude-sonnet-5-5" },
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: { "user-agent": "claude-cli/2.1.92", "x-app": "cli", "x-888-native-transformations": "true" },
      },
      reasoningEffortCap: "low",
    });
    expect(sentAdaptiveUnsetEffort.thinking).toEqual({ type: "adaptive" });
    expect(sentAdaptiveUnsetEffort.output_config).toEqual({ effort: "low" });

    mocks.executeMock.mockClear();
    const sentFable = await dispatch({
      body: {
        model: "claude-fable-5-1",
        stream: false,
        max_tokens: 32768,
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "hi" }],
      },
      modelInfo: { provider: "claude", model: "claude-fable-5-1" },
      sourceFormatOverride: "claude",
      providerThinking: { mode: "max" },
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: { "user-agent": "claude-cli/2.1.92", "x-app": "cli", "x-888-native-transformations": "true" },
      },
      reasoningEffortCap: "low",
    });
    expect(sentFable.thinking).toBeUndefined();
    expect(sentFable.output_config).toEqual({ effort: "low" });
  });

  it("clamps DeepSeek reasoning models (never sends max/xhigh under cap)", async () => {
    const sent = await dispatch({
      body: { model: "deepseek-v4-pro", stream: false, reasoning_effort: "max", messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "deepseek", model: "deepseek-v4-pro" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "low",
    });
    expect(sent.reasoning_effort).not.toBe("max");
    expect(sent.reasoning_effort).not.toBe("xhigh");
  });

  it("does NOT modify requests when preserveRequestInput is true (Claude passthrough or >=100k tokens)", async () => {
    const bodyNative = {
      model: "claude-sonnet-5-5",
      stream: false,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    };
    const sentNative = await dispatch({
      body: bodyNative,
      modelInfo: { provider: "claude", model: "claude-sonnet-5-5" },
      sourceFormatOverride: "claude",
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(bodyNative),
        headers: { "user-agent": "claude-cli/2.1.92", "x-app": "cli" },
      },
      reasoningEffortCap: "low",
    });
    expect(sentNative.output_config).toEqual({ effort: "max" });

    mocks.executeMock.mockClear();
    const hugePrompt = "abcd ".repeat(120000);
    const sentLarge = await dispatch({
      body: {
        model: "gpt-5",
        stream: false,
        reasoning_effort: "high",
        messages: [{ role: "user", content: hugePrompt }],
      },
      modelInfo: { provider: "openai", model: "gpt-5" },
      sourceFormatOverride: "openai",
      reasoningEffortCap: "low",
    });
    expect(sentLarge.reasoning_effort).toBe("high");
  });
});
