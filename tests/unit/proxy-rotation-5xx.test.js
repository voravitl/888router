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
  it("transient 5xx parks for ~30s (not the 5s hop cooldown)", () => {
    // Without parkMs on the status rules, markAccountUnavailable's fallback
    // used cooldownMs (5s) as the park — so a Vercel relay that needed ~20s to
    // recover was handed straight back within seconds and combo fell through to
    // the next provider while the relay was still down.
    for (const status of [503, 502, 504]) {
      const r = checkFallbackError(status, "transient", 0);
      expect(r.parkMs).toBeGreaterThanOrEqual(25_000); // ~30s
      expect(r.parkMs).toBeLessThanOrEqual(60_000);
      expect(r.cooldownMs).toBeLessThanOrEqual(5000); // hop stays short
    }
  });
  it("suspend-class still parks 30 min, transient only 30s", () => {
    const suspend = checkFallbackError(503, "USAGE_EXCEEDED suspended", 0);
    const transient = checkFallbackError(504, "An error occurred with your deployment", 0);
    expect(suspend.parkMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(transient.parkMs).toBeLessThanOrEqual(60_000);
  });
});
