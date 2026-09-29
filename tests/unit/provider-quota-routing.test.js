import { describe, it, expect, beforeEach, vi } from "vitest";

// Guards the quota-routing fix (issue #487): a provider that returns 429 must
// stop being retried for the REAL reset window, not the generic seconds/
// minutes backoff that let the combo flap straight back to the exhausted
// account. Two signal classes are covered: providers with a live quota API
// (antigravity — the reading is authoritative, contradictions become strikes)
// and providers with no API (ollama, opencode-free — strikes only).

const mocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(async (d) => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  })),
  getAntigravityUsage: vi.fn(async () => ({ quotas: {} })),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));

const {
  handleProviderQuotaError,
  clearProviderStrikes,
  getProviderQuotaCache,
  isQuotaTrackedProvider,
  __resetProviderQuotaCache,
} = await import("../../src/sse/services/providerQuota.js");

const CONN = "11111111-aaaa-bbbb-cccc-222222222222";
const MODEL = "claude-sonnet-4-6";
const HOUR = 3600_000;

function cachedReset(connId, model) {
  const q = getProviderQuotaCache().get(connId)?.[model];
  return q ? new Date(q.resetAt).getTime() : null;
}

describe("providerQuota — signal classes", () => {
  beforeEach(() => {
    __resetProviderQuotaCache();
    mocks.getAntigravityUsage.mockClear();
  });

  it("tracks exactly antigravity, ollama and opencode", () => {
    for (const p of ["antigravity", "ollama", "opencode"]) {
      expect(isQuotaTrackedProvider(p)).toBe(true);
    }
    expect(isQuotaTrackedProvider("openai")).toBe(false);
    expect(isQuotaTrackedProvider(undefined)).toBe(false);
  });

  it("rejects a provider that is not quota-tracked (fail closed, no cache writes)", async () => {
    await expect(
      handleProviderQuotaError("openai", CONN, 429, MODEL, "tok", {}),
    ).rejects.toThrow(/not quota-tracked/);
    expect(getProviderQuotaCache().size).toBe(0);
  });

  it("strike-only provider (no quota API): 3x 429 inside the window blocks 15m", async () => {
    const before = Date.now();
    expect(await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {})).toBeNull();
    const block = await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {});
    expect(block).not.toBeNull();
    // 15 minutes, ±5s of execution time
    expect(block).toBeGreaterThanOrEqual(before + 15 * 60_000 - 5_000);
    expect(block).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
    expect(cachedReset(CONN, MODEL)).toBe(block);
  });

  it("antigravity trusts an authoritative 0% reading and uses the REAL window (80h, not the 30m lock cap)", async () => {
    mocks.getAntigravityUsage.mockResolvedValueOnce({
      quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 80 * HOUR).toISOString() } },
    });
    const resetMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    // The point of the cache channel: a persisted modelLock is capped at 30m;
    // the cache must carry the full window for the pre-filter to skip on.
    expect(resetMs - Date.now()).toBeGreaterThan(79 * HOUR);
    expect(cachedReset(CONN, MODEL)).toBe(resetMs);
  });
});

describe("providerQuota — strike breaker semantics", () => {
  beforeEach(() => {
    __resetProviderQuotaCache();
    mocks.getAntigravityUsage.mockClear();
  });

  it("resets the count after a success (consecutive means consecutive)", async () => {
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    clearProviderStrikes(CONN, MODEL);
    // Two strikes before the clear; the third alone must NOT block.
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(cachedReset(CONN, MODEL)).toBeNull();
  });

  it("a synthesized block is cleared after success, a real upstream 0% is not", async () => {
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    const blockedUntil = await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    clearProviderStrikes(CONN, MODEL);
    expect(cachedReset(CONN, MODEL)).toBeNull();

    // A REAL 0% reading survives the clear — the account is genuinely dry.
    mocks.getAntigravityUsage.mockResolvedValueOnce({
      quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 2 * HOUR).toISOString() } },
    });
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    clearProviderStrikes(CONN, MODEL);
    expect(cachedReset(CONN, MODEL)).not.toBeNull();
  });

  it("strikes are keyed per connection|model — an unrelated model never blocks", async () => {
    // MODEL strike 1, then an unrelated model on the SAME connection (its own
    // breaker key, strike 1), then MODEL strikes 2 and 3 — only MODEL blocks,
    // and the unrelated model's own count stays under threshold.
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, "other-model", "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    const block = await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    expect(block).not.toBeNull();
    expect(cachedReset(CONN, MODEL)).toBe(block);
    // The unrelated model never crossed the threshold.
    expect(await handleProviderQuotaError("opencode", CONN, 429, "other-model", "tok", {})).toBeNull();
    expect(cachedReset(CONN, "other-model")).toBeNull();
  });

  it("a different connection is not poisoned by another's strikes", async () => {
    const other = "22222222-aaaa-bbbb-cccc-333333333333";
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    expect(await handleProviderQuotaError("opencode", other, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", other, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", other, 429, MODEL, "tok", {})).not.toBeNull();
  });

  it("an optimistic quota reading counts as a strike (API can lie while the endpoint 429s)", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [MODEL]: { remainingPercentage: 50, resetAt: new Date(Date.now() + HOUR).toISOString() } },
    });
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    const block = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(block).not.toBeNull();
  });

  it("an exhausted reading with a resetAt uses it immediately (no strike needed)", async () => {
    mocks.getAntigravityUsage.mockResolvedValueOnce({
      quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 3 * HOUR).toISOString() } },
    });
    const resetMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(resetMs).not.toBeNull();
    // A genuinely exhausted account is NOT a strike: repeating inside the
    // 30s throttle keeps reporting the SAME reset window (the cached reading
    // still says 0%), it never fabricates a block.
    const again = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(again).toBe(resetMs);
  });

  it("a 409 counts toward the strike threshold (antigravity signals pool exhaustion with 409 too)", async () => {
    expect(await handleProviderQuotaError("opencode", CONN, 409, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    const block = await handleProviderQuotaError("opencode", CONN, 409, MODEL, "tok", {});
    expect(block).not.toBeNull();
  });

  it("throttles refreshes to one quota call per 30s per connection (no amplification)", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {} });
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    const calls = mocks.getAntigravityUsage.mock.calls.length;
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(mocks.getAntigravityUsage.mock.calls.length).toBe(calls);
  });
});
