import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Regression guard for proxy-pool rotation on 5xx/usage-exceeded.
// Without the 503/502/504 + usage_exceeded rules in errorConfig, these
// transient relay-suspend errors fell to the 30s default stall instead of
// rotating quickly to the next proxy pool before combo switches provider.
describe("proxy pool rotation on 5xx / usage exceeded", () => {
  it("503 + USAGE_EXCEEDED → shouldFallback:true, short cooldown", () => {
    const r = checkFallbackError(503, "USAGE_EXCEEDED", 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeLessThanOrEqual(5000);
  });
  it("case-insensitive: usage_exceeded matches USAGE_EXCEEDED", () => {
    const r = checkFallbackError(503, "This application suspended: USAGE_EXCEEDED", 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBe(5000);
  });
  it("502/504 also rotate with short cooldown", () => {
    expect(checkFallbackError(502, "Bad Gateway", 0).shouldFallback).toBe(true);
    expect(checkFallbackError(504, "Gateway Timeout", 0).shouldFallback).toBe(true);
  });
});
