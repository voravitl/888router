import { beforeEach, describe, expect, it, vi } from "vitest";

// #517: when the client aborts mid-attempt, the account/pool loop in
// src/sse/handlers/chat.js must stop. Next aborts request.signal with a
// ResponseAborted (name != AbortError); the executors surfaced it as a failed
// attempt, and the loop then called markAccountUnavailable(…, 502, …) — parking
// the proxy pool for 30s — and moved on to the next account, which failed
// instantly on the same aborted signal. Every pool ended up parked by ONE
// cancelled request.

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  ensureModelContextLoaded: vi.fn(async () => {}),
  handleChatCore: vi.fn(),
  handleComboChat: vi.fn(),
  updateHealthEma: vi.fn(() => ({})),
  updateProviderConnection: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/modelContext.js", () => ({
  ensureModelContextLoaded: mocks.ensureModelContextLoaded,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));

vi.mock("@/sse/services/providerQuota.js", () => ({
  clearProviderStrikes: vi.fn(),
  handleProviderQuotaError: vi.fn(),
  isQuotaTrackedProvider: vi.fn(() => false),
}));

vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getProviderConnections: vi.fn(async () => []),
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  isAccountQualityFailure: vi.fn(() => false),
  updateHealthEma: mocks.updateHealthEma,
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));

vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...await importOriginal(),
  handleComboChat: mocks.handleComboChat,
}));

vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: mocks.handleChatCore,
}));

vi.mock("open-sse/translator/concerns/universalToolPrompt.js", () => ({
  resolveUniversalToolsMode: vi.fn(() => "off"),
}));

vi.mock("@/lib/headroom/detect", () => ({
  DEFAULT_HEADROOM_URL: "http://headroom:8787",
  resolveHeadroomUrl: vi.fn((url) => url),
}));

vi.mock("open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));

vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(),
}));

import { handleChat } from "@/sse/handlers/chat.js";

class ResponseAborted extends Error {
  constructor(...args) {
    super(...args);
    this.name = "ResponseAborted";
  }
}

const POOL = {
  connectionId: "noauth:pool-a",
  connectionName: "Public:relay-a",
  providerSpecificData: {},
  _connection: {},
};

function makeRequest(signal) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opencode/muse", messages: [{ role: "user", content: "hi" }] }),
    signal,
  });
}

function failedAttempt(status = 502) {
  return {
    success: false,
    status,
    error: `[${status}]: Unknown error`,
    response: new Response(JSON.stringify({ error: { message: "Unknown error" } }), { status }),
  };
}

describe("handleChat account loop on a client abort (#517)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "muse" });
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    // One account, then nothing: an unguarded loop that keeps going falls out
    // through "no more accounts" instead of spinning forever.
    mocks.getProviderCredentials.mockReset();
    mocks.getProviderCredentials.mockResolvedValueOnce(POOL).mockResolvedValue(null);
    // If the loop does consult it, it says "rotate to the next account".
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
  });

  it("gives each account its own complete message, image and tool payload", async () => {
    const original = { model: "opencode/muse", messages: [{ role: "user", content: [
      { type: "text", text: "original instruction" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ] }], tools: [{ type: "function", function: { name: "inspect", parameters: { type: "object" } } }] };
    const expected = structuredClone(original);
    mocks.getProviderCredentials.mockReset();
    mocks.getProviderCredentials.mockResolvedValueOnce(POOL).mockResolvedValueOnce({ ...POOL, connectionId: "second" });
    mocks.handleChatCore.mockImplementationOnce(async ({ body }) => {
      body.messages[0].content[0].text = "mutated by failed candidate";
      body.messages[0].content[1].image_url.url = "changed image";
      body.tools[0].function.parameters.type = "string";
      return failedAttempt(502);
    }).mockImplementationOnce(async ({ body }) => {
      expect(body).toEqual(expected);
      return { success: true, response: new Response("success") };
    });
    const request = new Request("http://localhost/v1/messages", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(original) });
    const response = await handleChat(request, { endpoint: "/v1/messages", body: original, headers: {} });
    expect(await response.text()).toBe("success");
    expect(original).toEqual(expected);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });

  it("combo cancellation reaches core even while the client request remains live", async () => {
    const combo = new AbortController();
    mocks.getComboModels.mockResolvedValueOnce(["opencode/muse"]);
    mocks.handleComboChat.mockImplementationOnce(({ body, handleSingleModel }) =>
      handleSingleModel(body, "opencode/muse", { signal: combo.signal }));
    mocks.handleChatCore.mockImplementationOnce(async ({ signal }) => {
      expect(signal.aborted).toBe(false);
      combo.abort(new Error("candidate timeout"));
      expect(signal.aborted).toBe(true);
      expect(signal.reason.message).toBe("candidate timeout");
      return failedAttempt(499);
    });
    const request = makeRequest(new AbortController().signal);
    const response = await handleChat(request);
    expect(request.signal.aborted).toBe(false);
    expect(response.status).toBe(499);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("credential-scoped cancellation reaches core and stops account rotation", async () => {
    const account = new AbortController();
    mocks.getProviderCredentials.mockReset();
    mocks.getProviderCredentials.mockResolvedValueOnce({ ...POOL, signal: account.signal });
    mocks.handleChatCore.mockImplementationOnce(async ({ signal }) => {
      account.abort(new Error("connection cancelled"));
      expect(signal.aborted).toBe(true);
      expect(signal.reason.message).toBe("connection cancelled");
      return failedAttempt(499);
    });
    await handleChat(makeRequest(new AbortController().signal));
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("local validation failure does not retry or mutate account health", async () => {
    mocks.handleChatCore.mockResolvedValueOnce({ ...failedAttempt(400), localValidationError: true });
    const response = await handleChat(makeRequest(new AbortController().signal));
    expect(response.status).toBe(400);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.updateHealthEma).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("hydrates synced context before combo selection and model resolution", async () => {
    mocks.handleChatCore.mockResolvedValueOnce(failedAttempt(502));
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false, cooldownMs: 0 });
    await handleChat(makeRequest(new AbortController().signal));
    expect(mocks.ensureModelContextLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.ensureModelContextLoaded.mock.invocationCallOrder[0]).toBeLessThan(mocks.getComboModels.mock.invocationCallOrder[0]);
    expect(mocks.ensureModelContextLoaded.mock.invocationCallOrder[0]).toBeLessThan(mocks.getModelInfo.mock.invocationCallOrder[0]);
  });

  it("rejects unauthorized requests before reading synced model metadata", async () => {
    mocks.getSettings.mockResolvedValueOnce({ requireApiKey: true });
    const response = await handleChat(makeRequest(new AbortController().signal));
    expect(response.status).toBe(401);
    expect(mocks.ensureModelContextLoaded).not.toHaveBeenCalled();
  });

  it.each([
    ["ResponseAborted (Next)", () => new ResponseAborted()],
    ["AbortError (DOMException)", () => new DOMException("The operation was aborted", "AbortError")],
  ])("%s: does not mark the account/pool unavailable and does not try further accounts", async (_label, makeReason) => {
    const ac = new AbortController();
    mocks.handleChatCore.mockImplementationOnce(async () => {
      ac.abort(makeReason()); // the client goes away while the attempt is in flight
      return failedAttempt(502);
    });

    const response = await handleChat(makeRequest(ac.signal));

    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502); // the failed attempt's own response is handed back untouched
  });

  it("also stops for a proper 499 result (checkFallbackError has no 499 rule and would cool the account down)", async () => {
    const ac = new AbortController();
    mocks.handleChatCore.mockImplementationOnce(async () => {
      ac.abort(new ResponseAborted());
      return failedAttempt(499);
    });

    const response = await handleChat(makeRequest(ac.signal));

    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(response.status).toBe(499);
  });

  it("a genuine upstream failure with a live client is still marked unavailable (behaviour preserved)", async () => {
    mocks.handleChatCore.mockImplementationOnce(async () => failedAttempt(502));
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false, cooldownMs: 0 });

    const response = await handleChat(makeRequest(new AbortController().signal));

    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable.mock.calls[0][0]).toBe("noauth:pool-a");
    expect(mocks.markAccountUnavailable.mock.calls[0][1]).toBe(502);
    expect(response.status).toBe(502);
  });

  it("forwards fusion panel deadline cancellation to chatCore without parking accounts", async () => {
    vi.useFakeTimers();
    try {
      mocks.getSettings.mockResolvedValue({ requireApiKey: false, comboStrategy: "fusion", comboStrategies: {
        "opencode/muse": { fusionTuning: { panelHardTimeoutMs: 100 } },
      } });
      mocks.getComboModels.mockResolvedValue(["opencode/a", "opencode/b"]);
      mocks.getProviderCredentials.mockReset().mockResolvedValue(POOL);
      const candidateSignals = [];
      mocks.handleChatCore.mockImplementation(({ signal }) => {
        candidateSignals.push(signal);
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(failedAttempt(499)), { once: true }));
      });
      const external = new AbortController();
      const pending = handleChat(makeRequest(external.signal));
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).status).toBe(503);
      expect(candidateSignals).toHaveLength(2);
      expect(candidateSignals.every((signal) => signal.aborted)).toBe(true);
      expect(external.signal.aborted).toBe(false);
      expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    } finally {
      mocks.handleChatCore.mockReset();
      vi.useRealTimers();
    }
  });
});
