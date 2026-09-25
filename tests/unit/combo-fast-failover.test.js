import { describe, it, expect, vi, afterEach } from "vitest";
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
  afterEach(() => {
    delete process.env.COMBO_TTFT_TIMEOUT_MS;
    delete process.env.COMBO_STALL_TIMEOUT_MS;
    delete process.env.COMBO_HEAD_DEADLINE_MS;
  });

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
  it("does not time out reasoning stream when chunks arrive regularly even if total elapsed exceeds TTFT timeout", async () => {
    // TTFT timeout 80ms, stall timeout 80ms.
    // 3 reasoning chunks arriving at 40ms intervals (total 120ms > 80ms TTFT timeout).
    // Previously, cumulative timer fired at 80ms and killed the reasoning stream!
    process.env.COMBO_TTFT_TIMEOUT_MS = "80";
    process.env.COMBO_STALL_TIMEOUT_MS = "80";
    const log = { info: vi.fn(), warn: vi.fn() };

    let pullCount = 0;
    const reasoningStream = new ReadableStream({
      async pull(c) {
        pullCount++;
        await new Promise(r => setTimeout(r, 40));
        if (pullCount === 1) {
          c.enqueue(enc("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"step 1\"}}]}\n\n"));
        } else if (pullCount === 2) {
          c.enqueue(enc("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"step 2\"}}]}\n\n"));
        } else if (pullCount === 3) {
          c.enqueue(enc("data: {\"choices\":[{\"delta\":{\"content\":\"final answer\"}}]}\n\n"));
          c.enqueue(enc("data: [DONE]\n\n"));
          c.close();
        }
      },
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      return new Response(reasoningStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["reasoning-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    const text = await res.text();
    expect(text).toContain("final answer");
    delete process.env.COMBO_TTFT_TIMEOUT_MS;
    delete process.env.COMBO_STALL_TIMEOUT_MS;
  });

  it("times out if stream stalls between chunks and falls over to next candidate", async () => {
    process.env.COMBO_TTFT_TIMEOUT_MS = "150";
    process.env.COMBO_STALL_TIMEOUT_MS = "50";
    const log = { info: vi.fn(), warn: vi.fn() };

    // Sends 1 chunk, then stalls indefinitely
    const stallingMidStream = new ReadableStream({
      start(c) {
        c.enqueue(enc("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"first chunk\"}}]}\n\n"));
        // then hangs, no close, no further chunks
      },
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "mid-stall-model") {
        return new Response(stallingMidStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(makeStream([
        "data: {\"choices\":[{\"delta\":{\"content\":\"fallback ok\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["mid-stall-model", "working-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    delete process.env.COMBO_TTFT_TIMEOUT_MS;
    delete process.env.COMBO_STALL_TIMEOUT_MS;
  });
  it("does not hang failover even if reader.cancel() hangs indefinitely", async () => {
    process.env.COMBO_TTFT_TIMEOUT_MS = "50";
    const log = { info: vi.fn(), warn: vi.fn() };

    // Stalling stream whose cancel() never resolves
    const uncancelableStream = new ReadableStream({
      start(c) {},
      cancel() {
        return new Promise(() => {}); // never resolves
      },
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "uncancelable-stalled-model") {
        return new Response(uncancelableStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(makeStream([
        "data: {\"choices\":[{\"delta\":{\"content\":\"recovered after uncancelable\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["uncancelable-stalled-model", "working-model"],
      handleSingleModel,
      log,
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // safeCancelReader bounds cancel to 300ms, so failover should complete promptly
    expect(elapsed).toBeLessThan(1500);
    delete process.env.COMBO_TTFT_TIMEOUT_MS;
  });
  it("times out on absolute decision deadline when provider trickles non-decisive chunks indefinitely", async () => {
    // Stall timeout 100ms, but absolute deadline 80ms.
    // Chunks arrive every 30ms (well within stall timeout), but decision is never reached.
    // Absolute deadline should fire at 80ms and fail over to next model!
    process.env.COMBO_TTFT_TIMEOUT_MS = "100";
    process.env.COMBO_STALL_TIMEOUT_MS = "100";
    process.env.COMBO_HEAD_DEADLINE_MS = "80";
    const log = { info: vi.fn(), warn: vi.fn() };

    let tricklingCanceled = false;
    let step = 0;
    const tricklingStream = new ReadableStream({
      async pull(c) {
        if (tricklingCanceled) return;
        step++;
        await new Promise(r => setTimeout(r, 30));
        if (tricklingCanceled) return;
        try {
          c.enqueue(enc(`data: {"choices":[{"delta":{"reasoning_content":"step ${step}"}}]}\n\n`));
        } catch {}
      },
      cancel() {
        tricklingCanceled = true;
      }
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "trickling-model") {
        return new Response(tricklingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(makeStream([
        "data: {\"choices\":[{\"delta\":{\"content\":\"recovered after deadline\"}}]}\n\n",
        "data: [DONE]\n\n",
      ]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["trickling-model", "working-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const text = await res.text();
    expect(text).toContain("recovered after deadline");
  });

  it("distinguishes reader error with message TTFT timeout from timer expiry (classifies 502 read error, not 504)", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    const brokenReadStream = new ReadableStream({
      start(c) {},
      pull() {
        throw new Error("TTFT timeout"); // socket error with coincidental message
      },
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      return new Response(brokenReadStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["broken-read-model"],
      handleSingleModel,
      log,
    });

    // Should classify as 502 read error, NOT 504 timeout!
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("stream head read error");
  });
  it("cleans up abort event listeners across multiple candidate failures without leaking", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    // Track attached listeners
    let listenerCount = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, fn, opts) => {
      if (type === "abort") listenerCount++;
      return origAdd(type, fn, opts);
    };
    signal.removeEventListener = (type, fn, opts) => {
      if (type === "abort") listenerCount--;
      return origRemove(type, fn, opts);
    };

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "fail-1" || model === "fail-2") {
        return new Response(JSON.stringify({ error: "fail" }), { status: 502 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["fail-1", "fail-2", "success-model"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    // Failed candidates (fail-1, fail-2) cleaned up their listeners! Only the selected success-model keeps its listener active.
    expect(listenerCount).toBe(1);
  });
  it("terminates combo loop promptly on client abort during pending stream head read without waiting for timeout", async () => {
    // 30s timeout, but client aborts after 30ms.
    // Must return 499 promptly (< 200ms) without waiting for TTFT timeout!
    process.env.COMBO_TTFT_TIMEOUT_MS = "30000";
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();

    const pendingStream = new ReadableStream({
      start(c) {
        // never sends anything
      },
    });

    const handleSingleModel = vi.fn(async () => {
      return new Response(pendingStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    setTimeout(() => abortCtrl.abort(), 30);

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["model-a", "model-b"],
      handleSingleModel,
      log,
      signal: abortCtrl.signal,
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(499);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(500);
  });
});
