import { afterEach, describe, expect, it, vi } from "vitest";
import { handleFusionChat } from "../../open-sse/services/combo.js";
const log = { info: vi.fn(), warn: vi.fn() };
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { headers: { "content-type": "application/json" } });
const body = { messages: [{ role: "user", content: "question" }] };
afterEach(() => vi.useRealTimers());
function waitForAbort(signal, onAbort) {
  return new Promise((_, reject) => signal.addEventListener("abort", () => {
    onAbort();
    reject(new Error("cancelled"));
  }, { once: true }));
}
describe("fusion cancels dropped provider work", () => {
  it("aborts a quorum straggler while preserving completed panels and the judge stream", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const signals = new Map();
    const single = vi.fn(async (_body, model, _panel, { signal }) => {
      signals.set(model, signal);
      if (model === "p/slow") return waitForAbort(signal, cancelled);
      return answer();
    });
    const pending = handleFusionChat({ body, models: ["p/a", "p/b", "p/slow"], judgeModel: "p/judge", handleSingleModel: single, tuning: { stragglerGraceMs: 100, panelHardTimeoutMs: 1000 }, log });
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(signals.get("p/slow").aborted).toBe(true);
    expect(signals.get("p/a").aborted).toBe(false);
    expect(signals.get("p/b").aborted).toBe(false);
    expect(signals.get("p/judge").aborted).toBe(false);
    expect(await response.json()).toHaveProperty("choices");
  });
  it("cancels all unfinished panels at their hard deadline", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const single = vi.fn((_body, _model, _panel, { signal }) => waitForAbort(signal, cancelled));
    const pending = handleFusionChat({ body, models: ["p/a", "p/b"], handleSingleModel: single, tuning: { panelHardTimeoutMs: 100 }, log });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(503);
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(single).toHaveBeenCalledTimes(2);
  });
  it("includes a stalled response body in the deadline rather than counting headers as a completed panel", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const single = vi.fn(async (_body, _model, _panel, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => { cancelled(); controller.error(new Error("cancelled")); }, { once: true });
      },
    }), { headers: { "content-type": "application/json" } }));
    const pending = handleFusionChat({ body, models: ["p/a", "p/b"], handleSingleModel: single, tuning: { panelHardTimeoutMs: 100 }, log });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(503);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it("aborts a stalled judge on deadline and reports 504", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const single = vi.fn(async (_body, _model, panel, { signal }) => panel ? answer() : waitForAbort(signal, cancelled));
    const pending = handleFusionChat({ body, models: ["p/a", "p/b"], handleSingleModel: single, tuning: { panelHardTimeoutMs: 100 }, log });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(504);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("combines external cancellation with each panel signal and stops without a judge", async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const cancelled = vi.fn();
    const single = vi.fn((_body, _model, _panel, { signal }) => waitForAbort(signal, cancelled));
    const pending = handleFusionChat({ body, models: ["p/a", "p/b"], handleSingleModel: single, signal: external.signal, log });
    await vi.advanceTimersByTimeAsync(0);
    external.abort();
    expect((await pending).status).toBe(499);
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(single).toHaveBeenCalledTimes(2);
  });
});
