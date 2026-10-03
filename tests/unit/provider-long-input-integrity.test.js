import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), fetch: vi.fn() }));
vi.mock("http2", () => ({ connect: (...args) => mocks.connect(...args) }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mocks.fetch(...args),
}));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: async () => ({ key: "qmodel_latest" }),
  resolveQoderModels: vi.fn(), isQoderPat: () => false, resolveQoderCredentials: vi.fn(),
}));

import { AipassExecutor } from "../../open-sse/executors/aipass.js";
import { CursorExecutor } from "../../open-sse/executors/cursor.js";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import { KimchiExecutor } from "../../open-sse/executors/kimchi.js";
import { getRequestTimeoutPolicy } from "../../open-sse/utils/requestTimeout.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocks.fetch.mockReset(); });

describe("provider long-input integrity", () => {
  it.each([true, false])("AiPASS rejects unsupported full-history requests before bridge dispatch (explicit=%s)", async (explicit) => {
    const body = { messages: [
      { role: "system", content: "retain this instruction" },
      { role: "user", content: explicit ? "prior turn" : "x".repeat(400000) },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "continue" },
    ], tools: [{ type: "function", function: { name: "read" } }] };
    const original = structuredClone(body);
    const result = await new AipassExecutor().execute({ body, credentials: { preserveRequestInput: explicit } });
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.type).toBe("unsupported_request");
    expect(body).toEqual(original);
  });

  it("Kimchi retains supplied reasoning during preservation while ordinary requests keep legacy stripping", () => {
    const body = { messages: [{ role: "assistant", content: "answer", reasoning_content: "valuable reasoning trace" }] };
    const executor = new KimchiExecutor();
    const preserved = executor.transformRequest("deepseek-r1", structuredClone(body), true, { preserveRequestInput: true });
    expect(preserved.messages[0].reasoning_content).toBe(body.messages[0].reasoning_content);
    const normal = executor.transformRequest("deepseek-r1", structuredClone(body), true, {});
    expect(normal.messages[0].reasoning_content).toBeUndefined();
  });

  it.each([false, true])("Cursor keeps a bounded whole-buffer deadline (long=%s)", async (long) => {
    vi.useFakeTimers();
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    const client = Object.assign(new EventEmitter(), { request: () => req, close: vi.fn() });
    mocks.connect.mockReturnValue(client);
    const policy = long ? getRequestTimeoutPolicy({ messages: [{ content: "x".repeat(400000) }] }) : null;
    const promise = new CursorExecutor().makeHttp2Request("https://example.com/chat", {}, Buffer.alloc(0), null, policy);
    const rejection = expect(promise).rejects.toThrow("HTTP/2 request timed out");
    const deadline = long ? policy.totalBudgetMs : 60000;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(client.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("Qoder applies the original request policy to the header deadline (long=%s)", async (long) => {
    vi.useFakeTimers();
    let upstreamSignal;
    mocks.fetch.mockImplementation(async (_url, options) => {
      upstreamSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    });
    const policy = getRequestTimeoutPolicy({ messages: [{ content: long ? "x".repeat(400000) : "hi" }] });
    const executor = new QoderExecutor();
    const promise = executor.execute({ model: "qmodel_latest", body: { messages: [{ role: "user", content: "translated body" }] }, credentials: {
      accessToken: "dt-test", providerSpecificData: { userId: "test-user" }, requestTimeoutPolicy: policy,
    } });
    const rejection = expect(promise).rejects.toThrow("fetch connect timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(upstreamSignal).toBeDefined();
    const deadline = long ? Math.max(executor.config.timeoutMs, policy.connectTimeoutMs) : executor.config.timeoutMs;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(upstreamSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });
});
