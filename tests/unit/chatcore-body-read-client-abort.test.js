import { beforeEach, describe, expect, it, vi } from "vitest";

// #517 review (independent reviewer, confirmed by execution): a client that
// disconnects AFTER the provider returned its headers — while the body is still
// being read for a non-streaming / forced-SSE→JSON request — made the read
// reject with Next's ResponseAborted. These sub-handlers caught it as a
// provider failure: logged "FAILED 502" and returned "Invalid JSON response".
// It is a 499.

const { convertMock } = vi.hoisted(() => ({ convertMock: vi.fn() }));

vi.mock("../../open-sse/transformer/streamToJsonConverter.js", () => ({
  convertResponsesStreamToJson: convertMock,
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

import { handleNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

class ResponseAborted extends Error {
  constructor(...args) {
    super(...args);
    this.name = "ResponseAborted";
  }
}

function makeArgs(providerResponse, overrides = {}) {
  return {
    providerResponse,
    provider: "opencode",
    model: "m",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: {},
    stream: false,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "c1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {} },
    onRequestSuccess: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    reqLogger: { logProviderResponse: vi.fn() },
    ...overrides,
  };
}

function headers(contentType) {
  return { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) };
}

describe("non-streaming body read: client abort is a 499, not a provider 502", () => {
  beforeEach(() => convertMock.mockReset());

  it("json() rejecting with ResponseAborted → 499 / FAILED 499", async () => {
    const args = makeArgs({
      status: 200,
      statusText: "OK",
      headers: headers("application/json"),
      json: () => Promise.reject(new ResponseAborted()),
    });

    const result = await handleNonStreamingResponse(args);

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(args.appendLog).toHaveBeenCalledWith({ status: "FAILED 499" });
  });

  it("Responses-SSE conversion rejecting with ResponseAborted → 499", async () => {
    convertMock.mockRejectedValueOnce(new ResponseAborted());
    const args = makeArgs(
      { status: 200, statusText: "OK", headers: headers("text/event-stream"), body: {} },
      { targetFormat: FORMATS.OPENAI_RESPONSES },
    );

    const result = await handleNonStreamingResponse(args);

    expect(result.status).toBe(499);
    expect(args.appendLog).toHaveBeenCalledWith({ status: "FAILED 499" });
  });

  it("a genuinely malformed provider body is still a 502", async () => {
    const args = makeArgs({
      status: 200,
      statusText: "OK",
      headers: headers("application/json"),
      json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await handleNonStreamingResponse(args);

    expect(result.status).toBe(502);
    expect(args.appendLog).toHaveBeenCalledWith({ status: "FAILED 502" });
    consoleError.mockRestore();
  });
});

describe("forced SSE→JSON: client abort is a 499, not a provider 502", () => {
  beforeEach(() => convertMock.mockReset());

  it("Responses path: stream conversion rejecting with ResponseAborted → 499", async () => {
    convertMock.mockRejectedValueOnce(new ResponseAborted());
    const args = makeArgs(
      { status: 200, statusText: "OK", headers: headers("text/event-stream"), body: {} },
      { targetFormat: FORMATS.OPENAI_RESPONSES },
    );

    const result = await handleForcedSSEToJson(args);

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });

  it("Chat Completions path: text() rejecting with ResponseAborted → 499", async () => {
    const args = makeArgs({
      status: 200,
      statusText: "OK",
      headers: headers("text/event-stream"),
      text: () => Promise.reject(new ResponseAborted()),
      body: { getReader: () => ({ read: () => Promise.reject(new ResponseAborted()), releaseLock() {} }) },
    });

    const result = await handleForcedSSEToJson(args);

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
  });

  it("a genuine conversion failure is still a 502", async () => {
    convertMock.mockRejectedValueOnce(new Error("bad sse"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const args = makeArgs(
      { status: 200, statusText: "OK", headers: headers("text/event-stream"), body: {} },
      { targetFormat: FORMATS.OPENAI_RESPONSES },
    );

    const result = await handleForcedSSEToJson(args);

    expect(result.status).toBe(502);
    consoleError.mockRestore();
  });
});
