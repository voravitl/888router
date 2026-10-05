import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fitMock, estimateMock, fetchMock } = vi.hoisted(() => ({
  fitMock: vi.fn(), estimateMock: vi.fn(), fetchMock: vi.fn(),
}));
vi.mock("../../open-sse/services/requestContext.js", () => ({
  getContextFit: (...args) => fitMock(...args),
  estimateRequestTokens: (...args) => estimateMock(...args),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));
import { handleComboChat, handleFusionChat, clearComboHeadTimeoutCooldown, clearComboKnownUnavailable } from "../../open-sse/services/combo.js";

beforeEach(() => clearComboKnownUnavailable());
afterEach(() => clearComboKnownUnavailable());
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { getRequestTimeoutPolicy } from "../../open-sse/utils/requestTimeout.js";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "complete" } }] }), {
  headers: { "content-type": "application/json" },
});
beforeEach(() => {
  vi.clearAllMocks();
  fitMock.mockReturnValue({ fits: null });
  estimateMock.mockReturnValue(100);
  clearComboHeadTimeoutCooldown();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LONG_CONTEXT_TIMEOUT_MS;
});

describe("provider-independent combo capacity guard", () => {
  it("prefers estimated fitting candidates even with autoSwitch disabled, preserving the body", async () => {
    const body = { messages: [{ role: "user", content: "full history" }], max_output_tokens: 64000 };
    const original = structuredClone(body);
    fitMock.mockImplementation((_, model) => ({ fits: model === "small/model" ? false : true, reason: model === "small/model" ? "context_length_exceeded" : null }));
    const single = vi.fn(answer);
    const response = await handleComboChat({ body, models: ["small/model", "large/model"], autoSwitch: false, handleSingleModel: single, log });
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0][0]).toBe(body);
    expect(single.mock.calls[0][1]).toBe("large/model");
    expect(body).toEqual(original);
  });
  it("fails clearly without any upstream request when every declared output budget is insufficient", async () => {
    fitMock.mockReturnValue({ fits: false, reason: "output_limit_exceeded" });
    const single = vi.fn(answer);
    const response = await handleComboChat({ body: {}, models: ["openai/small", "gemini/small"], handleSingleModel: single, log });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("output_limit_exceeded");
    expect(single).not.toHaveBeenCalled();
  });
  it("leaves unknown limits permissive rather than inventing a 200k maximum", async () => {
    const single = vi.fn(answer);
    const response = await handleComboChat({ body: {}, models: ["custom/unknown"], handleSingleModel: single, log });
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalledTimes(1);
  });
  it("retains approximately oversized candidates for authoritative upstream fallback", async () => {
    fitMock.mockImplementation((_, model) => ({ fits: model === "estimated-small" ? false : true, reason: model === "estimated-small" ? "context_length_exceeded" : null }));
    const body = { messages: [{ role: "user", content: "unchanged full history" }] };
    const single = vi.fn(async (request, model) => {
      expect(request).toBe(body);
      return model === "known-large" ? new Response("Unavailable", { status: 502 }) : answer();
    });
    const response = await handleComboChat({ body, models: ["estimated-small", "known-large"], handleSingleModel: single, log });
    expect(response.status).toBe(200);
    expect(single.mock.calls.map((call) => call[1])).toEqual(["known-large", "estimated-small"]);
  });
  it("does not issue a reasoning retry whose raised output reservation exceeds declared capacity", async () => {
    fitMock.mockImplementation((body) => ({ fits: body.max_tokens <= 1000, reason: body.max_tokens > 1000 ? "output_limit_exceeded" : null }));
    const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking" } }] }), { headers: { "content-type": "application/json" } }));
    await handleComboChat({ body: { max_tokens: 1000 }, models: ["test/model"], handleSingleModel: single, log });
    expect(single).toHaveBeenCalledTimes(1);
  });
  it("also guards single-model fusion rather than bypassing capacity checks", async () => {
    fitMock.mockReturnValue({ fits: false, reason: "output_limit_exceeded" });
    const single = vi.fn(answer);
    const response = await handleFusionChat({ body: {}, models: ["small/model"], handleSingleModel: single, log });
    expect(response.status).toBe(400);
    expect(single).not.toHaveBeenCalled();
  });
});

describe("large request bounded waits", () => {
  it("gives large fusion panels the adaptive wait instead of the ordinary 30 second deadline", async () => {
    vi.useFakeTimers();
    estimateMock.mockReturnValue(500000);
    const single = vi.fn(async (_body, _model, panel) => {
      if (panel) await new Promise((resolve) => setTimeout(resolve, 45000));
      return answer();
    });
    const pending = handleFusionChat({ body: { messages: [{ role: "user", content: "long request" }] }, models: ["panel/a", "panel/b"], handleSingleModel: single, log });
    await vi.advanceTimersByTimeAsync(45000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalledTimes(3);
  });
  it("retains ordinary combo connect timeout and extends large prefill to 180 seconds", async () => {
    vi.useFakeTimers();
    let requestSignal;
    fetchMock.mockImplementation((_url, options) => {
      requestSignal = options.signal;
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    });
    const executor = new BaseExecutor("test", { baseUrl: "https://upstream.invalid", timeoutMs: 1000 });
    const ordinary = executor.execute({ body: {}, credentials: {}, isCombo: true });
    const ordinaryError = expect(ordinary).rejects.toThrow("fetch connect timeout");
    await vi.advanceTimersByTimeAsync(1000);
    await ordinaryError;
    estimateMock.mockReturnValue(500000);
    const large = executor.execute({ body: {}, credentials: {}, isCombo: true });
    const largeError = expect(large).rejects.toThrow("fetch connect timeout");
    await vi.advanceTimersByTimeAsync(179999);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal.aborted).toBe(true);
    await largeError;
  });
  it("allows a large stream to start beyond the ordinary 30 second first-byte cutoff", async () => {
    vi.useFakeTimers();
    estimateMock.mockReturnValue(500000);
    const single = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
          controller.close();
        }, 90000);
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const pending = handleComboChat({ body: { stream: true }, models: ["large/model"], handleSingleModel: single, log });
    await vi.advanceTimersByTimeAsync(90000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("answer");
    expect(single).toHaveBeenCalledTimes(1);
  });
  it("bounds operator long-context overrides and leaves normal requests unchanged", () => {
    process.env.LONG_CONTEXT_TIMEOUT_MS = "999999999";
    expect(getRequestTimeoutPolicy({}).connectTimeoutMs).toBe(10000);
    estimateMock.mockReturnValue(100000);
    expect(getRequestTimeoutPolicy({}).connectTimeoutMs).toBe(300000);
    process.env.LONG_CONTEXT_TIMEOUT_MS = "invalid";
    expect(getRequestTimeoutPolicy({}).connectTimeoutMs).toBe(180000);
  });
});
