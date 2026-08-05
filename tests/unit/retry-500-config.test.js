import { describe, it, expect } from "vitest";

// The 500 "MODEL_TEMPORARILY_UNAVAILABLE" overload error should be retried
// in-place by the executor before it surfaces to the client / account fallback.
describe("default retry config", () => {
  it("includes a single transient retry for 500 (MODEL_TEMPORARILY_UNAVAILABLE)", async () => {
    const { DEFAULT_RETRY_CONFIG, resolveRetryEntry } = await import("../../open-sse/config/runtimeConfig.js");
    const retry = resolveRetryEntry(DEFAULT_RETRY_CONFIG[500]);
    // exactly 1 attempt — bounds latency on genuinely-broken endpoints while
    // still absorbing a transient overload (regression guard against 2+)
    expect(retry.attempts).toBe(1);
    expect(retry.delayMs).toBeGreaterThan(0);
  });

  it("kiro provider retry config does not override the 500 transient retry", async () => {
    const { DEFAULT_RETRY_CONFIG } = await import("../../open-sse/config/runtimeConfig.js");
    const kiroEntry = (await import("../../open-sse/providers/registry/kiro.js")).default;
    const merged = { ...DEFAULT_RETRY_CONFIG, ...kiroEntry.transport.retry };
    // kiro sets { 429: 0 } only — the default 500 retry must survive the merge
    expect(merged[500]).toEqual(DEFAULT_RETRY_CONFIG[500]);
    expect(merged[500].attempts).toBe(1);
  });
});
