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
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

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
  updateProviderConnection: vi.fn(async () => {}),
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  isAccountQualityFailure: vi.fn(() => false),
  updateHealthEma: vi.fn(() => ({})),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
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
});
