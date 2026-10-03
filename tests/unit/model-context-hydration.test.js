import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/db/repos/syncedModelsRepo.js", () => ({ getAllModelDynamicCapabilities: (...args) => load(...args) }));
let hydrate;
let fit;
let reset;
const log = { warn: vi.fn() };
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  load.mockReset();
  log.warn.mockReset();
  ({ ensureModelContextLoaded: hydrate } = await import("@/sse/services/modelContext.js"));
  ({ getContextFit: fit } = await import("../../open-sse/services/requestContext.js"));
  ({ __resetScopedDynamicCache: reset } = await import("../../open-sse/providers/capabilities.js"));
  reset();
});
afterEach(() => { reset(); vi.useRealTimers(); });
const request = { messages: [{ role: "user", content: "x".repeat(2000000) }], max_tokens: 8000 };

describe("synced context hydration before chat routing", () => {
  it("loads future scoped model metadata on cold start without /v1/models", async () => {
    expect(fit(request, "openai/future-sync-model").fits).toBe(null);
    load.mockResolvedValue(new Map([["openai:future-sync-model", { contextWindow: 1000000, maxOutput: 16000 }], ["future-sync-model", { contextWindow: 9999999 }]]));
    await hydrate(log);
    expect(fit(request, "openai/future-sync-model").fits).toBe(true);
    expect(fit(request, "google/future-sync-model").fits).toBe(null);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent first requests and refreshes changed metadata within 30 seconds", async () => {
    let resolve;
    load.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const a = hydrate(log);
    const b = hydrate(log);
    expect(load).toHaveBeenCalledTimes(1);
    resolve(new Map([["openai:future-sync-model", { contextWindow: 1000000 }]]));
    await Promise.all([a, b]);
    await hydrate(log);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    load.mockResolvedValue(new Map([["openai:future-sync-model", { contextWindow: 128000 }]]));
    await hydrate(log);
    expect(load).toHaveBeenCalledTimes(2);
    expect(fit(request, "openai/future-sync-model").fits).toBe(false);
  });
  it("fails open without logging error contents, retains last good limits and retries after five seconds", async () => {
    load.mockResolvedValueOnce(new Map([["openai:future-sync-model", { contextWindow: 1000000 }]]));
    await hydrate(log);
    await vi.advanceTimersByTimeAsync(30000);
    load.mockRejectedValueOnce(new Error("secret-provider-token"));
    await hydrate(log);
    expect(fit(request, "openai/future-sync-model").fits).toBe(true);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-provider-token");
    await hydrate(log);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    load.mockResolvedValueOnce(new Map());
    await hydrate(log);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("bounds a stuck database read and ignores its late result", async () => {
    let resolve;
    load.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = hydrate(log);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(log.warn).toHaveBeenCalledTimes(1);
    resolve(new Map([["openai:future-sync-model", { contextWindow: 1000000 }]]));
    await Promise.resolve();
    expect(fit(request, "openai/future-sync-model").fits).toBe(null);
    await vi.advanceTimersByTimeAsync(5000);
    load.mockResolvedValueOnce(new Map());
    await hydrate(log);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
