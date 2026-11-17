import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  handleChatCoreMock: vi.fn(),
  getModelInfoMock: vi.fn(),
  getProviderCredentialsMock: vi.fn(),
  checkAndRefreshTokenMock: vi.fn(),
  getComboModelsMock: vi.fn(),
  markAccountUnavailableMock: vi.fn(),
}));

describe("Session Affinity (open-sse/utils/sessionAffinity.js + sessionManager + chat.js)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/localDb");
    vi.doUnmock("open-sse/handlers/chatCore.js");
    vi.doUnmock("../../src/sse/services/model.js");
    vi.doUnmock("../../src/sse/services/auth.js");
    vi.doUnmock("../../src/sse/services/tokenRefresh.js");
    vi.doUnmock("../../src/sse/services/modelContext.js");
    vi.doUnmock("../../src/sse/services/providerQuota.js");
    vi.doUnmock("../../open-sse/utils/sessionAffinity.js");
    vi.doUnmock("open-sse/utils/sessionAffinity.js");
    vi.doUnmock("../../open-sse/utils/loopBreaker.js");
    vi.doUnmock("open-sse/utils/loopBreaker.js");
  });

  it("extracts Hermes, OpenCode, LiteLLM, Grok headers and live_session_id in resolveSessionIdentity", async () => {
    const { resolveSessionIdentity, clearSessionStore } = await import("../../open-sse/utils/sessionManager.js");
    clearSessionStore();

    expect(resolveSessionIdentity({
      headers: { "x-opencode-session": "hermes-ses-001" },
      body: { messages: [{ role: "user", content: "hi" }] },
      scope: "claude",
    })).toEqual({ sessionId: "hermes-ses-001", ephemeral: false });

    expect(resolveSessionIdentity({
      headers: { "x-hermes-session-id": "hermes-ses-002" },
      body: { messages: [{ role: "user", content: "hi" }] },
      scope: "openai",
    })).toEqual({ sessionId: "hermes-ses-002", ephemeral: false });

    expect(resolveSessionIdentity({
      headers: {},
      body: { metadata: { live_session_id: "hermes-meta-99" }, messages: [{ role: "user", content: "hi" }] },
      scope: "openai",
    })).toEqual({ sessionId: "hermes-meta-99", ephemeral: false });
  });

  it("pins per-provider session keys across turns, falls back to assistant text, and skips stateless single-turns", async () => {
    const {
      resolveChatSessionAffinityKey,
      pinConnection,
      getPinnedConnection,
      clearAffinityStore,
    } = await import("../../open-sse/utils/sessionAffinity.js");
    const { clearSessionStore } = await import("../../open-sse/utils/sessionManager.js");
    clearAffinityStore();
    clearSessionStore();

    // Stateless one-shot call with no session signal returns null
    expect(resolveChatSessionAffinityKey({
      headers: {},
      body: { messages: [{ role: "user", content: "hello" }] },
      provider: "claude",
    })).toBeNull();

    // Claude Code UUID session key isolates per provider
    const ccBody = {
      metadata: { user_id: "user_abc_session_11111111-2222-3333-4444-555555555555" },
      messages: [{ role: "user", content: "hi" }],
    };
    const keyClaude = resolveChatSessionAffinityKey({ headers: {}, body: ccBody, provider: "claude" });
    const keyCodex = resolveChatSessionAffinityKey({ headers: {}, body: ccBody, provider: "codex" });
    expect(keyClaude).toBeTruthy();
    expect(keyCodex).toBeTruthy();
    expect(keyClaude).not.toBe(keyCodex);

    pinConnection(keyClaude, "conn-claude-2");
    expect(getPinnedConnection(keyClaude)).toBe("conn-claude-2");
    // Respects excludeConnectionIds during failover
    expect(getPinnedConnection(keyClaude, new Set(["conn-claude-2"]))).toBeNull();

    // Multi-turn Hermes / OpenAI request without explicit session header falls back to stable assistant text hash
    const assistantText = "This is a detailed assistant explanation exceeding fifty characters for session stability.";
    const multiTurnKey = resolveChatSessionAffinityKey({
      headers: {},
      body: {
        messages: [
          { role: "user", content: "step 1" },
          { role: "assistant", content: assistantText },
          { role: "user", content: "step 2" },
        ],
      },
      provider: "claude",
    });
    expect(multiTurnKey).toMatch(/^claude:/);
  });

  it("chat.js pins successful session connections via preferredConnectionId and falls back cleanly when excluded", async () => {
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      rtkEnabled: true,
      sessionAffinityEnabled: true,
      loopBreakerEnabled: true,
    });
    mocks.getComboModelsMock.mockResolvedValue(null);
    mocks.getModelInfoMock.mockResolvedValue({ provider: "claude", model: "claude-sonnet-5-5" });
    mocks.checkAndRefreshTokenMock.mockImplementation(async (_p, creds) => creds);
    mocks.markAccountUnavailableMock.mockResolvedValue({ shouldFallback: true });

    let callNum = 0;
    mocks.getProviderCredentialsMock.mockImplementation(async (_provider, exclude, _model, opts) => {
      callNum++;
      if (opts?.preferredConnectionId && !exclude?.has(opts.preferredConnectionId)) {
        return {
          connectionId: opts.preferredConnectionId,
          connectionName: `acct-${opts.preferredConnectionId}`,
          apiKey: "tok",
          providerSpecificData: {},
        };
      }
      if (!exclude?.has("conn-2")) {
        return { connectionId: "conn-2", connectionName: "acct-2", apiKey: "tok-2", providerSpecificData: {} };
      }
      return { connectionId: "conn-1", connectionName: "acct-1", apiKey: "tok-1", providerSpecificData: {} };
    });

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
      markAccountUnavailable: mocks.markAccountUnavailableMock,
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

    const { clearAffinityStore } = await import("../../open-sse/utils/sessionAffinity.js");
    const { clearLoopBreakerStore } = await import("../../open-sse/utils/loopBreaker.js");
    clearAffinityStore();
    clearLoopBreakerStore();

    const { handleChat } = await import("../../src/sse/handlers/chat.js");

    // Turn 1: Hermes session header picks conn-2, succeeds, and pins conn-2
    const makeReq = (sid, text) => new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": sid,
        "User-Agent": "HermesAgent/0.14.0",
      },
      body: JSON.stringify({
        model: "claude/claude-sonnet-5-5",
        stream: false,
        messages: [{ role: "user", content: text }],
      }),
    });

    const r1 = await handleChat(makeReq("hermes-s1", "turn 1"));
    expect(r1.status).toBe(200);
    expect(mocks.getProviderCredentialsMock.mock.calls[0][3]).toEqual({ preferredConnectionId: null });

    // Turn 2: same session -> passes preferredConnectionId: "conn-2"
    const r2 = await handleChat(makeReq("hermes-s1", "turn 2"));
    expect(r2.status).toBe(200);
    expect(mocks.getProviderCredentialsMock.mock.calls[1][3]).toEqual({ preferredConnectionId: "conn-2" });

    // Turn 3: pinned conn-2 fails 429 -> fallback picks conn-1, succeeds, and re-pins to conn-1
    mocks.handleChatCoreMock
      .mockResolvedValueOnce({
        success: false,
        status: 429,
        error: "rate limit",
        response: new Response("rate limit", { status: 429 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
      });

    const r3 = await handleChat(makeReq("hermes-s1", "turn 3"));
    expect(r3.status).toBe(200);
    expect(callNum).toBe(4); // tried conn-2, fell back to conn-1

    const r4 = await handleChat(makeReq("hermes-s1", "turn 4"));
    expect(r4.status).toBe(200);
    expect(mocks.getProviderCredentialsMock.mock.calls[4][3]).toEqual({ preferredConnectionId: "conn-1" });
  });
});
