import { describe, it, expect } from "vitest";
import { isModelLockActive, MODEL_LOCK_ALL } from "../../open-sse/services/accountFallback.js";

describe("isModelLockActive: computed lock is the single source of truth", () => {
  it("returns false when modelLock___all has expired even if testStatus is 'unavailable' and lastErrorAt was 3s ago", () => {
    const now = Date.now();
    const conn = {
      testStatus: "unavailable",
      lastErrorAt: new Date(now - 3000).toISOString(),
      [MODEL_LOCK_ALL]: new Date(now - 1000).toISOString(),
    };
    expect(isModelLockActive(conn, "m")).toBe(false);
  });

  it("returns true when modelLock___all is still active in the future", () => {
    const now = Date.now();
    const conn = {
      testStatus: "unavailable",
      lastErrorAt: new Date(now - 3000).toISOString(),
      [MODEL_LOCK_ALL]: new Date(now + 5000).toISOString(),
    };
    expect(isModelLockActive(conn, "m")).toBe(true);
  });
});
