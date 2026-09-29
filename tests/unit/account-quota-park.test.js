import { describe, it, expect, vi, beforeEach } from "vitest";

// These tests use the REAL classifier + error config — the 402 marker gate
// and park windows are invisible under a mocked checkFallbackError (same
// lesson as proxy-pool-quarantine.test.js).
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async () => null),
  updateProxyPool: vi.fn(async () => ({})),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((p) => p),
  FREE_PROVIDERS: {},
  AI_PROVIDERS: {},
}));

vi.mock("open-sse/config/retiredProviders.js", () => ({
  isRetiredProvider: vi.fn(() => false),
}));

vi.mock("open-sse/services/quotaSnapshot.js", () => ({
  partitionByQuotaHealth: vi.fn((conns) => ({ healthy: conns })),
  QUOTA_AVOID_THRESHOLD_PCT: 0.9,
  QUOTA_SNAPSHOT_MAX_AGE_MS: 60_000,
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  pickByScore: vi.fn((pool) => ({ connection: pool[0], breakdown: { reason: "mock" } })),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
}));

const { markAccountUnavailable, clearAccountError } =
  await import("../../src/sse/services/auth.js");
const { ACCOUNT_QUOTA_PARK_MS } = await import("../../open-sse/config/errorConfig.js");

const HOUR = ACCOUNT_QUOTA_PARK_MS;
const TWO_MIN = 2 * 60 * 1000;
const lockMsOf = (update, key) => new Date(update[key]).getTime() - Date.now();

function connRow(provider = "kiro") {
  return { id: "conn-1", provider, name: "Account 1", accessToken: "tok" };
}

describe("markAccountUnavailable — 402 quota texts get ACCOUNT_QUOTA_PARK_MS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([connRow()]);
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("402 with MONTHLY_REQUEST_COUNT locks the account for ~1h, not 2min", async () => {
    const r = await markAccountUnavailable(
      "conn-1", 402, '{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}',
      "kiro", "claude-opus-5",
    );

    expect(r.shouldFallback).toBe(true);
    // Return value stays the short hop cooldown — it only paces this request.
    expect(r.cooldownMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, update] = mocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-1");

    expect(update["modelLock___all"]).toBeTruthy();
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeGreaterThan(HOUR - 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(HOUR + 60 * 1000);
    expect(update.rateLimitedUntil).toBeTruthy();
    expect(update.unavailableUntil).toBeTruthy();
    expect(update.testStatus).toBe("unavailable");
    expect(update.errorCode).toBe(402);
  });

  it("402 without model still parks account-level for ~1h", async () => {
    await markAccountUnavailable("conn-1", 402, "You have reached the limit.", "kiro");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    expect(lockMsOf(update, "modelLock___all")).toBeGreaterThan(TWO_MIN + 60 * 1000);
  });

  it("bare 402 without a quota marker keeps the short rule cooldown (no blanket park)", async () => {
    await markAccountUnavailable("conn-1", 402, "Subscription not active for model", "kiro", "claude-opus-5");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
  });

  it("resetsAtMs overrides the 402 park (precise provider reset wins)", async () => {
    const resetsAt = Date.now() + 10 * 60 * 1000; // 10min < 1h park
    await markAccountUnavailable("conn-1", 402, "reached the limit", "kiro", "claude-opus-5", resetsAt);
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    const lockMs = lockMsOf(update, "modelLock___all");
    // precise reset (10min), NOT the 1h park
    expect(lockMs).toBeGreaterThan(9 * 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(11 * 60 * 1000);
  });

  // Regression pin for review finding #1: MAX_RATE_LIMIT_COOLDOWN_MS (30min)
  // truncated the reset, which silently DISABLED the 1h park and handed a
  // still-dead quota account back after 30min. Precedence is now explicit —
  // the park takes over whenever the cap would have truncated the reset.
  it("resetsAtMs BEYOND the 30min cap falls back to the 1h park, not the cap", async () => {
    const resetsAt = Date.now() + 90 * 60 * 1000; // 90min > MAX_RATE_LIMIT_COOLDOWN_MS
    await markAccountUnavailable("conn-1", 402, "reached the limit", "kiro", "claude-opus-5", resetsAt);
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeGreaterThan(HOUR - 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(HOUR + 60 * 1000);
  });

  it("resetsAtMs at the 30min cap boundary still earns the park (not the cap)", async () => {
    const resetsAt = Date.now() + 45 * 60 * 1000; // > cap, would truncate to 30min
    await markAccountUnavailable("conn-1", 402, "MONTHLY_REQUEST_COUNT", "kiro", "claude-opus-5", resetsAt);
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeGreaterThan(HOUR - 60 * 1000);
  });

  // Review finding #3: the marker gate intentionally also parks billing 402s
  // that merely MENTION a balance. They only clear when a human acts, so the
  // park is correct — pinned here so a future narrowing is a deliberate,
  // test-visible change rather than an accident.
  it("402 payment-method text mentioning a balance also parks (intended, not over-match)", async () => {
    for (const text of ["Your credit card is required", "Insufficient Balance", "Payment Required — add funds"]) {
      vi.clearAllMocks();
      mocks.getProviderConnections.mockResolvedValue([connRow()]);
      mocks.updateProviderConnection.mockResolvedValue({});
      const r = await markAccountUnavailable("conn-1", 402, text, "kiro", "claude-opus-5");
      const update = mocks.updateProviderConnection.mock.calls[0]?.[1];
      const lockMs = update ? lockMsOf(update, "modelLock___all") : 0;
      // "Payment Required" alone carries no marker -> short cooldown. The two
      // that name a balance/credit are billing dead ends -> full park.
      const expectedPark = /credit|balance/i.test(text);
      if (expectedPark) {
        expect(lockMs, text).toBeGreaterThan(HOUR - 60 * 1000);
      } else {
        expect(lockMs, text).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
      }
      expect(r.shouldFallback, text).toBe(true);
    }
  });

  it("401 keeps the short rule cooldown (transient auth, not billing)", async () => {
    await markAccountUnavailable("conn-1", 401, "unauthorized", "kiro", "claude-opus-5");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    const lockMs = lockMsOf(update, "modelLock_claude-opus-5");
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
    expect(lockMs).toBeLessThan(HOUR - 60 * 1000);
  });

  it("429 keeps backoff-based cooldown (recoverable rate window)", async () => {
    await markAccountUnavailable("conn-1", 429, "rate limit exceeded", "kiro", "claude-opus-5");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    // "rate limit exceeded" matches the quota-class text, so this is an
    // account-level lock — but the window is backoff-based (seconds), not 1h.
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeLessThan(HOUR - 60 * 1000);
  });

  it("403 keeps the short rule cooldown", async () => {
    await markAccountUnavailable("conn-1", 403, "permission denied", "kiro", "claude-opus-5");
    const update = mocks.updateProviderConnection.mock.calls[0][1];
    // 403 is account-level, but keeps the short 2min rule cooldown, not 1h.
    const lockMs = lockMsOf(update, "modelLock___all");
    expect(lockMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
  });
});

describe("clearAccountError — 402 parked account is re-admitted only by expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not clear or rewrite a still-active account-level park on success", async () => {
    const future = new Date(Date.now() + HOUR).toISOString();
    const parked = {
      id: "conn-1",
      provider: "kiro",
      testStatus: "unavailable",
      lastError: "reached the limit",
      modelLock___all: future,
      rateLimitedUntil: future,
      unavailableUntil: future,
    };
    mocks.getProviderConnections.mockResolvedValue([parked]);

    await clearAccountError("conn-1", { ...parked, _connection: parked }, "claude-opus-5");

    // No write at all: the park is still active, the success must not touch it.
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("clears an EXPIRED account-level lock on success (recovery path)", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const expired = {
      id: "conn-1",
      provider: "kiro",
      testStatus: "unavailable",
      lastError: "reached the limit",
      modelLock___all: past,
      rateLimitedUntil: past,
      unavailableUntil: past,
    };
    mocks.getProviderConnections.mockResolvedValue([expired]);

    await clearAccountError("conn-1", { ...expired, _connection: expired }, "claude-opus-5");

    const calls = mocks.updateProviderConnection.mock.calls.filter((c) => c[0] === "conn-1");
    expect(calls.length).toBeGreaterThan(0);
    const update = calls[0][1];
    expect(update["modelLock___all"]).toBeNull();
    expect(update.testStatus).toBe("active");
  });

  // Regression pin for review finding #2: the snapshot handed to
  // clearAccountError is the one captured at SELECTION time. If another
  // request re-parked the account after that snapshot, clearing from the
  // stale row would merge modelLock___all:null over the FRESH park
  // (connectionsRepo.updateProviderConnection is a blind read-modify-write).
  it("re-reads before clearing, so a concurrent re-park is not erased", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    // Snapshot the caller passes: the account-level lock looks EXPIRED, so
    // without a re-read this path would happily write null over it.
    const staleSnapshot = {
      id: "conn-1",
      provider: "kiro",
      testStatus: "unavailable",
      lastError: "reached the limit",
      modelLock___all: past,
      rateLimitedUntil: past,
      unavailableUntil: past,
    };
    // The DB, as of the re-read: another request re-parked it moments ago.
    const freshFuture = new Date(Date.now() + HOUR).toISOString();
    const freshRow = { ...staleSnapshot, modelLock___all: freshFuture, rateLimitedUntil: freshFuture, unavailableUntil: freshFuture };
    mocks.getProviderConnections.mockResolvedValue([freshRow]);

    await clearAccountError("conn-1", { ...staleSnapshot, _connection: staleSnapshot }, "claude-opus-5");

    // The fresh park must survive: it is still active, so it is neither
    // nulled nor counted as an expired lock.
    const calls = mocks.updateProviderConnection.mock.calls.filter((c) => c[0] === "conn-1");
    for (const [, update] of calls) {
      expect(update["modelLock___all"]).not.toBeNull();
      expect(update.testStatus).not.toBe("active");
    }
  });

  it("still clears when the re-read confirms the lock is genuinely expired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const expired = {
      id: "conn-1",
      provider: "kiro",
      testStatus: "unavailable",
      lastError: "reached the limit",
      modelLock___all: past,
      rateLimitedUntil: past,
      unavailableUntil: past,
    };
    mocks.getProviderConnections.mockResolvedValue([expired]);

    await clearAccountError("conn-1", { ...expired, _connection: expired }, "claude-opus-5");

    const calls = mocks.updateProviderConnection.mock.calls.filter((c) => c[0] === "conn-1");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][1]["modelLock___all"]).toBeNull();
  });
});
