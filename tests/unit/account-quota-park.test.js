import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock localDb (getProviderConnections/updateProviderConnection) — auth.js
// imports the whole localDb module; only these two functions matter here.
vi.mock("../../../src/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => true),
  getProxyPoolById: vi.fn(async () => null),
  updateProxyPool: vi.fn(async () => true),
  getProxyPools: vi.fn(async () => []),
}));
vi.mock("../../../src/lib/localDb/adapters", () => ({}));

import {
  markAccountUnavailable,
  clearAccountError,
} from "../../../src/sse/services/auth.js";
import { ACCOUNT_QUOTA_PARK_MS } from "../../../open-sse/config/errorConfig.js";
import { getProviderConnections, updateProviderConnection } from "../../../src/lib/localDb";

const HOUR = ACCOUNT_QUOTA_PARK_MS;
const TWO_MIN = 2 * 60 * 1000;

function connRow(provider = "kiro") {
  return {
    id: "conn-1",
    provider,
    name: "Account 1",
    accessToken: "tok",
  };
}

describe("markAccountUnavailable — 402 monthly quota gets ACCOUNT_QUOTA_PARK_MS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([connRow()]);
  });

  it("402 with MONTHLY_REQUEST_COUNT locks the account for ~1h, not 2min", async () => {
    const r = await markAccountUnavailable(
      "conn-1", 402, '{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}',
      "kiro", "claude-opus-5",
    );

    expect(r.shouldFallback).toBe(true);
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, update] = updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-1");

    const allExpiry = update["modelLock___all"];
    expect(allExpiry).toBeTruthy();
    const lockMs = new Date(allExpiry).getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(HOUR - 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(HOUR + 60 * 1000);
    // account-level flags set too
    expect(update.rateLimitedUntil).toBeTruthy();
    expect(update.unavailableUntil).toBeTruthy();
    expect(update.testStatus).toBe("unavailable");
    expect(update.errorCode).toBe(402);
  });

  it("402 without model still parks account-level for ~1h", async () => {
    await markAccountUnavailable("conn-1", 402, "You have reached the limit.", "kiro");
    const update = updateProviderConnection.mock.calls[0][1];
    const lockMs = new Date(update["modelLock___all"]).getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(TWO_MIN + 60 * 1000);
  });

  it("resetsAtMs overrides the 402 park (precise provider reset wins)", async () => {
    const resetsAt = Date.now() + 10 * 60 * 1000; // 10min < 1h park
    await markAccountUnavailable("conn-1", 402, "reached the limit", "kiro", "claude-opus-5", resetsAt);
    const update = updateProviderConnection.mock.calls[0][1];
    const lockMs = new Date(update["modelLock___all"]).getTime() - Date.now();
    // precise reset (10min), NOT the 1h park
    expect(lockMs).toBeGreaterThan(9 * 60 * 1000);
    expect(lockMs).toBeLessThanOrEqual(11 * 60 * 1000);
  });

  it("401 keeps the short rule cooldown (transient auth, not billing)", async () => {
    await markAccountUnavailable("conn-1", 401, "unauthorized", "kiro", "claude-opus-5");
    const update = updateProviderConnection.mock.calls[0][1];
    const lockMs = new Date(update["modelLock_claude-opus-5"]).getTime() - Date.now();
    expect(lockMs).toBeGreaterThan(0);
    expect(lockMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
    expect(lockMs).toBeLessThan(HOUR - 60 * 1000);
  });

  it("429 keeps backoff-based cooldown (recoverable rate window)", async () => {
    await markAccountUnavailable("conn-1", 429, "rate limit exceeded", "kiro", "claude-opus-5");
    const update = updateProviderConnection.mock.calls[0][1];
    const lockMs = new Date(update["modelLock_claude-opus-5"]).getTime() - Date.now();
    expect(lockMs).toBeLessThan(HOUR - 60 * 1000);
  });

  it("403 keeps the short rule cooldown", async () => {
    await markAccountUnavailable("conn-1", 403, "permission denied", "kiro", "claude-opus-5");
    const update = updateProviderConnection.mock.calls[0][1];
    const lockMs = new Date(update["modelLock_claude-opus-5"]).getTime() - Date.now();
    expect(lockMs).toBeLessThanOrEqual(TWO_MIN + 60 * 1000);
  });
});

describe("clearAccountError — 402 parked account is re-admitted only by expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not clear a still-active account-level lock on success", async () => {
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
    getProviderConnections.mockResolvedValue([parked]);

    await clearAccountError("conn-1", { ...parked, _connection: parked }, "claude-opus-5");

    // Success through a different model must NOT clear the account-level 402 park
    const calls = updateProviderConnection.mock.calls.filter((c) => c[0] === "conn-1");
    const cleared = calls.length > 0 && calls[0][1]["modelLock___all"] === null;
    expect(cleared).toBe(false);
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
    getProviderConnections.mockResolvedValue([expired]);

    await clearAccountError("conn-1", { ...expired, _connection: expired }, "claude-opus-5");

    const calls = updateProviderConnection.mock.calls.filter((c) => c[0] === "conn-1");
    expect(calls.length).toBeGreaterThan(0);
    const update = calls[0][1];
    expect(update["modelLock___all"]).toBeNull();
    expect(update.testStatus).toBe("active");
  });
});
