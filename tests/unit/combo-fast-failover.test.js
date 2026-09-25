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
    // While the returned response body is unconsumed, the abort listener is active
    expect(listenerCount).toBe(1);
    // Once the response body is consumed to completion, listener is cleaned up!
    await res.json();
    expect(listenerCount).toBe(0);
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
  it("aborts candidate upstream signal and cleans up listener when client cancels selected stream body", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

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

    let candidateSignal;
    const testStream = makeStream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"chunk 1\"}}]}\\n\\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"chunk 2\"}}]}\\n\\n",
    ]);

    const handleSingleModel = vi.fn(async (body, model, opts) => {
      candidateSignal = opts?.signal;
      return new Response(testStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["stream-model"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(200);
    expect(listenerCount).toBe(1);
    expect(candidateSignal.aborted).toBe(false);

    // Downstream cancels reading
    await res.body.cancel();

    // Upstream candidate signal is aborted, and listener on client signal is removed!
    expect(candidateSignal.aborted).toBe(true);
    expect(listenerCount).toBe(0);
  });

  it("cleans up client abort listener after selected stream body is consumed to completion", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

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

    const testStream = makeStream([
      "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\\n\\n",
      "data: [DONE]\\n\\n",
    ]);

    const handleSingleModel = vi.fn(async () => {
      return new Response(testStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["stream-model"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(200);
    expect(listenerCount).toBe(1);

    // Consume stream completely
    const text = await res.text();
    expect(text).toContain("hello");
    // After EOF, listener is cleaned up
    expect(listenerCount).toBe(0);
  });

  it("aborts upstream signal and cleans up listener when streamed reasoning-budget retry is cancelled", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

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

    let retrySignal;
    let callCount = 0;
    const handleSingleModel = vi.fn(async (body, model, opts) => {
      callCount++;
      if (callCount === 1) {
        // Stream exhausted on reasoning
        return new Response(makeStream([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":\"length\"}]}\\n\\n",
          "data: [DONE]\\n\\n",
        ]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      retrySignal = opts?.signal;
      return new Response(makeStream([
        "data: {\"choices\":[{\"delta\":{\"content\":\"retry answer\"}}]}\\n\\n",
      ]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["reasoning-model"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(listenerCount).toBe(1);
    expect(retrySignal.aborted).toBe(false);

    // Cancel the retry stream body
    await res.body.cancel();
    expect(retrySignal.aborted).toBe(true);
    expect(listenerCount).toBe(0);
  });

  it("cleans up client abort listener when streamed reasoning-budget retry throws", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

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

    let callCount = 0;
    const handleSingleModel = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Stream exhausted on reasoning
        return new Response(makeStream([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":\"length\"}]}\\n\\n",
          "data: [DONE]\\n\\n",
        ]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // Retry throws network error
      throw new Error("retry network reset");
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["reasoning-model"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(500);
    expect(callCount).toBe(2);
    // Listener must be cleaned up on throw
    expect(listenerCount).toBe(0);
  });

  it("terminates combo loop with 499 when client aborts during retry and does not try subsequent models", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    let callCount = 0;
    const handleSingleModel = vi.fn(async (body, model) => {
      callCount++;
      if (callCount === 1) {
        return new Response(makeStream([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":\"length\"}]}\\n\\n",
          "data: [DONE]\\n\\n",
        ]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (callCount === 2) {
        // Model 1 retry: client aborts while retry is in flight
        abortCtrl.abort();
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }
      // Model 2: should NEVER be reached!
      return new Response(JSON.stringify({ choices: [{ message: { content: "model-b ok" } }] }), { status: 200 });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["model-a", "model-b"],
      handleSingleModel,
      log,
      signal,
    });

    expect(res.status).toBe(499);
    // model-b was NOT tried!
    expect(callCount).toBe(2);
  });

  it("handles empty body with throwing cancel without crashing and falls over to next candidate", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    const brokenEmptyStream = new ReadableStream({
      start(c) {
        c.close();
      },
      cancel() {
        throw new Error("sync cancel crash");
      }
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "empty-crashing-model") {
        return new Response(brokenEmptyStream, {
          status: 200,
          headers: { "content-length": "0" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "fallback ok" } }] }), { status: 200 });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["empty-crashing-model", "working-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("fallback ok");
  });
  it("races pending handleSingleModel against client abort and returns 499 promptly", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();

    // Model never settles
    const handleSingleModel = vi.fn(() => new Promise(() => {}));

    setTimeout(() => abortCtrl.abort(), 30);

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["hanging-model"],
      handleSingleModel,
      log,
      signal: abortCtrl.signal,
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(499);
    expect(elapsed).toBeLessThan(500);
  });

  it("cancels retried.body and aborts retry controller when streamed retry returns non-2xx", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    let retryBodyCanceled = false;
    let retrySignal;

    const retryFailedStream = new ReadableStream({
      start(c) {},
      cancel() { retryBodyCanceled = true; }
    });

    let callCount = 0;
    const handleSingleModel = vi.fn(async (body, model, opts) => {
      callCount++;
      if (callCount === 1) {
        // Model 1 exhausts reasoning budget
        return new Response(makeStream([
          "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":\"length\"}]}\\n\\n",
          "data: [DONE]\\n\\n",
        ]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (callCount === 2) {
        // Model 1 retry returns 502 with a body
        retrySignal = opts?.signal;
        return new Response(retryFailedStream, {
          status: 502,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // Model 2 succeeds
      return new Response(JSON.stringify({ choices: [{ message: { content: "model-2 ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const res = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hi" }] },
      models: ["model-1", "model-2"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(callCount).toBe(3);
    expect(retrySignal?.aborted).toBe(true);
    expect(retryBodyCanceled).toBe(true);
  });
  it("cancels late-resolving response body if executor settles after client abort", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();

    let lateBodyCanceled = false;
    const lateStream = new ReadableStream({
      start(c) {},
      cancel() { lateBodyCanceled = true; }
    });

    let resolveModel;
    const handleSingleModel = vi.fn(() => new Promise((resolve) => {
      resolveModel = resolve;
    }));

    // Abort after 20ms
    setTimeout(() => abortCtrl.abort(), 20);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["slow-model"],
      handleSingleModel,
      log,
      signal: abortCtrl.signal,
    });

    expect(res.status).toBe(499);

    // Executor resolves late with a response
    resolveModel(new Response(lateStream, { status: 200 }));
    // Wait for microtask loop
    await new Promise((r) => setTimeout(r, 50));

    // Late body must have been automatically cancelled!
    expect(lateBodyCanceled).toBe(true);
  });

  it("cancels discarded non-2xx candidate response body before falling through to next model", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    let failedBodyCanceled = false;

    const failedStream = new ReadableStream({
      start(c) {},
      cancel() { failedBodyCanceled = true; }
    });

    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "fail-model") {
        return new Response(failedStream, {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/plain" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["fail-model", "working-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    // Discarded failure body was cancelled!
    expect(failedBodyCanceled).toBe(true);
  });

  it("aborts candidate and returns 499 if client aborts during non-2xx error body parsing", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const abortCtrl = new AbortController();
    let errorStreamCanceled = false;
    let candidateAborted = false;

    const hangingErrorStream = new ReadableStream({
      start(c) {},
      cancel() { errorStreamCanceled = true; }
    });

    const handleSingleModel = vi.fn(async (body, model, opts) => {
      opts?.signal?.addEventListener("abort", () => { candidateAborted = true; });
      // Trigger abort while error body parsing is in progress
      setTimeout(() => abortCtrl.abort(), 20);
      return new Response(hangingErrorStream, {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["fail-model", "working-model"],
      handleSingleModel,
      log,
      signal: abortCtrl.signal,
    });

    expect(res.status).toBe(499);
    expect(candidateAborted).toBe(true);
    expect(errorStreamCanceled).toBe(true);
  });

  it("handles stream wrapper failure by aborting candidate and cancelling stream", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    let candidateAborted = false;
    let streamCanceled = false;

    const handleSingleModel = vi.fn(async (body, model, opts) => {
      opts?.signal?.addEventListener("abort", () => { candidateAborted = true; });
      const stream = new ReadableStream({
        start(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { streamCanceled = true; }
      });
      const resp = new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      });
      // Lock stream AFTER Response creation so wrapSelectedBody fails when calling stream.getReader()
      resp.body.getReader();
      return resp;
    });

    // Should not throw unhandled exception, falls through to next or finishes gracefully
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["locked-model"],
      handleSingleModel,
      log,
    });

    expect(candidateAborted).toBe(true);
  });

  it("aborts candidate controller when non-streamed reasoning retry fails", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    let initialCandidateAborted = false;
    let retryBodyCanceled = false;

    const failedRetryStream = new ReadableStream({
      start(c) {},
      cancel() { retryBodyCanceled = true; }
    });

    let callCount = 0;
    const handleSingleModel = vi.fn(async (body, model, opts) => {
      callCount++;
      if (callCount === 1) {
        opts?.signal?.addEventListener("abort", () => { initialCandidateAborted = true; });
        return new Response(JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: "thinking..." }, finish_reason: "length" }]
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (callCount === 2) {
        // Retry returns non-ok
        return new Response(failedRetryStream, {
          status: 502,
          headers: { "content-type": "text/plain" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "fallback ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["reasoning-fail-model", "fallback-model"],
      handleSingleModel,
      log,
    });

    expect(res.status).toBe(200);
    expect(initialCandidateAborted).toBe(true);
    expect(retryBodyCanceled).toBe(true);
  });
});
