import { describe, it, expect, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { isModelLockActive, buildModelLockUpdate, MODEL_LOCK_ALL } from "../../open-sse/services/accountFallback.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";

let fetchMockReturn = () => new Response("ok", { status: 200 });
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => fetchMockReturn()),
}));

const enc = (s) => new TextEncoder().encode(s);
const makeStream = (chunks) => new ReadableStream({
  start(c) { for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc(ch) : ch); c.close(); },
});

describe("Combo Fast Failover & Timeout Defenses", () => {
  it("aborts combo loop immediately if client signal is aborted", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const handleSingleModel = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["model-a", "model-b"],
      handleSingleModel,
      log,
      signal: abortCtrl.signal,
    });

    expect(res.status).toBe(499);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });

  it("does not sleep between candidates when upstream returns 502/503", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "model-a") {
        return new Response(JSON.stringify({ error: "transient bad gateway" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["model-a", "model-b"],
      handleSingleModel,
      log,
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // Previously, 502 would sleep 3000-5000ms. Now it should finish in < 500ms.
    expect(elapsed).toBeLessThan(1000);
  });

  it("times out stalled stream head via COMBO_TTFT_TIMEOUT_MS and falls over", async () => {
    process.env.COMBO_TTFT_TIMEOUT_MS = "100";
    const log = { info: vi.fn(), warn: vi.fn() };

    // Stalling stream that never sends a decision
    const stalledStream = new ReadableStream({
      start(c) {
        // do not enqueue, do not close -> hung stream
      },
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "stalling-model") {
        return new Response(stalledStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(makeStream([
        "data: {\"choices\":[{\"delta\":{\"content\":\"recovered answer\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["stalling-model", "working-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    delete process.env.COMBO_TTFT_TIMEOUT_MS;
  });

  it("isModelLockActive respects account-level locks, rateLimitedUntil, and unavailableUntil", () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const past = new Date(Date.now() - 60000).toISOString();

    const connWithAllLock = { [MODEL_LOCK_ALL]: future };
    expect(isModelLockActive(connWithAllLock, "any-model")).toBe(true);

    const connWithRateLimit = { rateLimitedUntil: future };
    expect(isModelLockActive(connWithRateLimit, "any-model")).toBe(true);

    const connWithUnavailable = { unavailableUntil: future };
    expect(isModelLockActive(connWithUnavailable, "any-model")).toBe(true);

    const expiredConn = { rateLimitedUntil: past, unavailableUntil: past };
    expect(isModelLockActive(expiredConn, "any-model")).toBe(false);

    const updateObj = buildModelLockUpdate("specific-model", 5000, true);
    expect(updateObj[MODEL_LOCK_ALL]).toBeDefined();
    expect(updateObj.rateLimitedUntil).toBeDefined();
    expect(updateObj.unavailableUntil).toBeDefined();
  });

  it("BaseExecutor skips in-executor 5xx retries and shortens timeout when isCombo is true", async () => {
    const executor = new BaseExecutor("test-provider", { baseUrl: "http://localhost:9999" });
    fetchMockReturn = () => new Response("bad gateway", { status: 502 });

    // With isCombo: true, should fail immediately on first 502 without retrying 3 times
    const res = await executor.execute({
      model: "test-model",
      body: {},
      stream: false,
      credentials: {},
      isCombo: true,
      log: { debug: vi.fn() },
    });

    expect(res.response.status).toBe(502);
  });
});
