import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit test: executor-level retry is skipped for proxy-pool requests (5xx)
// so chat.js pool rotation happens immediately instead of ~9s of in-executor
// retries on the same dead pool.
//
// We test the small decision helper directly. base.js's `execute()` computes
// `throughProxyPool` from proxyOptions and passes `retryConfig[statusKey]`
// (or undefined for pool+5xx) into resolveRetryEntry. Rather than drive the
// full HTTP loop, assert: with a pool id present, a 5xx yields zero attempts;
// without a pool, the default config attempts are preserved.

import { resolveRetryEntry } from "../../open-sse/config/runtimeConfig.js";

// Helper mirroring base.js logic: skipForPool → undefined config → 0 attempts.
// statusKey string like "503" or a number; retryConfigByStatus indexed like retryConfig.
function attemptsFor({ throughProxyPool, statusKey, retryConfigByStatus }) {
  const is5xx = typeof statusKey === "number" && statusKey >= 500 && statusKey < 600;
  const skip = throughProxyPool && is5xx;
  const entryForStatus = retryConfigByStatus[statusKey];
  const { attempts } = resolveRetryEntry(skip ? undefined : entryForStatus);
  return attempts;
}

const RETRY = {
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 },
  500: { attempts: 1, delayMs: 3000 },
};

describe("executor retry for proxy-pool requests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("5xx through a proxy pool → zero in-executor retries (rotate immediately)", () => {
    expect(attemptsFor({ statusKey: 503, retryConfigByStatus: RETRY, throughProxyPool: true })).toBe(0);
    expect(attemptsFor({ statusKey: 502, retryConfigByStatus: RETRY, throughProxyPool: true })).toBe(0);
    expect(attemptsFor({ statusKey: 500, retryConfigByStatus: RETRY, throughProxyPool: true })).toBe(0);
    expect(attemptsFor({ statusKey: 504, retryConfigByStatus: RETRY, throughProxyPool: true })).toBe(0);
  });

  it("non-pool request keeps the normal retry config", () => {
    expect(attemptsFor({ statusKey: 503, retryConfigByStatus: RETRY, throughProxyPool: false })).toBe(3);
    expect(attemptsFor({ statusKey: 502, retryConfigByStatus: RETRY, throughProxyPool: false })).toBe(3);
    expect(attemptsFor({ statusKey: 500, retryConfigByStatus: RETRY, throughProxyPool: false })).toBe(1);
  });

  it("4xx through a proxy pool still uses retry config (not a 5xx server-error)", () => {
    // 429 → backoff (attempts 0 anyway in DEFAULT_RETRY_CONFIG) — but the
    // point: throughProxyPool only zeroes 5xx, not 4xx.
    expect(attemptsFor({ statusKey: 429, retryConfigByStatus: { 429: { attempts: 2, delayMs: 1000 } }, throughProxyPool: true })).toBe(2);
  });
});