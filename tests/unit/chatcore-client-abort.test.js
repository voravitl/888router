// #517: a client abort (Next's ResponseAborted, name != AbortError) must be classified as 499,
// not as a provider 502 "Unknown error".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, appendRequestLogMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  appendRequestLogMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: appendRequestLogMock,
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

class ResponseAborted extends Error {
  constructor(...args) {
    super(...args);
    this.name = "ResponseAborted";
  }
}

function makeOptions(signal) {
  const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal,
  };
}

describe("handleChatCore classifies a client abort as 499", () => {
  beforeEach(() => {
    executeMock.mockReset();
    appendRequestLogMock.mockClear();
  });

  it("ResponseAborted from the executor → 499 'Request aborted', logged as FAILED 499", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const ac = new AbortController();
    const reason = new ResponseAborted();
    ac.abort(reason);
    executeMock.mockRejectedValueOnce(reason);

    const result = await handleChatCore(makeOptions(ac.signal));

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(result.error).toBe("Request aborted");
    expect(appendRequestLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 499" }));
  });

  it("a generic error surfaced after the client aborted is still the abort, not a provider 502", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const ac = new AbortController();
    ac.abort(new ResponseAborted());
    executeMock.mockRejectedValueOnce(new Error("fetch failed"));

    const result = await handleChatCore(makeOptions(ac.signal));

    expect(result.status).toBe(499);
    expect(appendRequestLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 499" }));
  });

  it("a genuine upstream failure with a live client is still a 502", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    executeMock.mockRejectedValueOnce(new Error("boom"));

    const result = await handleChatCore(makeOptions(new AbortController().signal));

    expect(result.status).toBe(502);
    expect(appendRequestLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502" }));
  });
});
