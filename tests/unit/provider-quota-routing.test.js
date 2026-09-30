import { describe, it, expect, beforeEach, vi } from "vitest";

// Guards the quota-routing fix (issue #487): a provider that returns 429 must
// stop being retried for the REAL reset window, not the generic seconds/
// minutes backoff that let the combo flap straight back to the exhausted
// account. Two signal classes:
//   antigravity — has a live quota API; the reading is authoritative and a
//                 reading that contradicts a 429 becomes a strike; quota is
//                 PER MODEL, so strikes are keyed per model.
//   ollama / opencode — NO quota API; their 429 ("Rate limit exceeded", or
//                 ollama's "you (lvoravit) have reached your monthly usage
//                 limit") names the ACCOUNT with no reset hint, so strikes
//                 are keyed per ACCOUNT and a multi-model combo cannot keep
//                 the breaker below threshold by rotating models.

const mocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  })),
  getAntigravityUsage: vi.fn(async () => ({ quotas: {} })),
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
  isQuotaTrackedProvider,
  isPairBlocked,
  __resetProviderQuotaCache,
} = await import("../../src/sse/services/providerQuota.js");

const CONN = "11111111-aaaa-bbbb-cccc-222222222222";
const OTHER_CONN = "22222222-aaaa-bbbb-cccc-333333333333";
const MODEL = "claude-sonnet-4-6";
const HOUR = 3600_000;

// What the auth pre-filter will actually see. The raw cache also holds
// optimistic (50%) API readings, so cache presence is NOT "blocked".
const pairBlocked = (providerId, connId, model) => isPairBlocked(providerId, connId, model);

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
    expect(isPairBlocked("openai", CONN, MODEL)).toBeNull();
  });

  it("strike-only provider (no quota API): 3x 429 inside the window blocks 5m — the shorter wall for a rolling per-account limit", async () => {
    const before = Date.now();
    expect(await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {})).toBeNull();
    const block = await handleProviderQuotaError("ollama", CONN, 429, MODEL, "tok", {});
    expect(block).not.toBeNull();
    // 5 minutes for strike-only providers (a rolling per-account wall), not
    // the 15m used for a quota-API contradiction. ±5s of execution time.
    expect(block).toBeGreaterThanOrEqual(before + 5 * 60_000 - 5_000);
    expect(block).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 5_000);
    expect(pairBlocked("ollama", CONN, MODEL)).toBe(block);
  });

  it("antigravity trusts an authoritative 0% reading and uses the REAL window (80h, not the 30m lock cap)", async () => {
    mocks.getAntigravityUsage.mockResolvedValueOnce({
      quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 80 * HOUR).toISOString() } },
    });
    const resetMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(resetMs).not.toBeNull();
    // The point of the cache channel: a persisted modelLock is capped at 30m;
    // the cache must carry the full window for the pre-filter to skip on.
    expect(resetMs - Date.now()).toBeGreaterThan(79 * HOUR);
    expect(pairBlocked("antigravity", CONN, MODEL)).toBe(resetMs);
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
    clearProviderStrikes("opencode", CONN, MODEL);
    // Two strikes before the clear; the third alone must NOT block.
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(pairBlocked("opencode", CONN, MODEL)).toBeNull();
  });

  it("a synthesized block is cleared after success, a real upstream 0% is not", async () => {
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    const blockMs = await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    expect(blockMs).not.toBeNull();
    clearProviderStrikes("opencode", CONN, MODEL);
    expect(pairBlocked("opencode", CONN, MODEL)).toBeNull();

    // A REAL 0% reading survives the clear — the account is genuinely dry.
    mocks.getAntigravityUsage.mockResolvedValueOnce({
      quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 2 * HOUR).toISOString() } },
    });
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    clearProviderStrikes("antigravity", CONN, MODEL);
    expect(pairBlocked("antigravity", CONN, MODEL)).not.toBeNull();
  });

  it("strike-only keying is PER MODEL — a strike on one model never blocks a sibling", async () => {
    // Was account-level (`conn|*`) so that ollama/opencode's account-metered
    // quota could not be kept under threshold by rotating models. That had two
    // live consequences, both observed on 2026-09-30:
    //   - clearProviderStrikes() wipes the account key on ANY success, so a
    //     combo walking muse-spark (429) into space-bunny-free (200) reset the
    //     count every time: 55 strikes recorded, breaker tripped 0 times.
    //   - when it did trip, the account block took space-bunny-free down for
    //     5 minutes even though it was serving fine.
    // The 429 is per MODEL on these providers: on the same `a5857d08` account
    // muse-spark returns FreeUsageLimitError every request while
    // space-bunny-free serves normally.
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, "other-model", "tok", {})).toBeNull();
    // Neither has reached the threshold on its own count.
    expect(pairBlocked("opencode", CONN, MODEL)).toBeNull();
    expect(pairBlocked("opencode", CONN, "other-model")).toBeNull();
    // Each needs its own 3rd strike.
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    const blockMs = await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    expect(blockMs).not.toBeNull();
    // MODEL is blocked; its healthy sibling is NOT collateral damage.
    expect(pairBlocked("opencode", CONN, MODEL)).toBe(blockMs);
    expect(pairBlocked("opencode", CONN, "other-model")).toBeNull();
  });

  it("a success on a DIFFERENT model does not clear this model's strikes", async () => {
    // The exact production sequence: muse-spark 429s, the combo's next
    // candidate space-bunny-free succeeds on the same account, and the strike
    // count must survive it. With the account key this third 429 returned null.
    const BAD = "muse-spark-1.3-contributor-free";
    const GOOD = "space-bunny-free";
    expect(await handleProviderQuotaError("opencode", "noauth", 429, BAD, "tok", {})).toBeNull();
    clearProviderStrikes("opencode", "noauth", GOOD);
    expect(await handleProviderQuotaError("opencode", "noauth", 429, BAD, "tok", {})).toBeNull();
    clearProviderStrikes("opencode", "noauth", GOOD);
    const blockMs = await handleProviderQuotaError("opencode", "noauth", 429, BAD, "tok", {});
    expect(blockMs).not.toBeNull();
    // The model that kept working is still usable.
    expect(pairBlocked("opencode", "noauth", GOOD)).toBeNull();
  });

  it("a success on the SAME model does still reset its own count", async () => {
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    clearProviderStrikes("opencode", CONN, MODEL);
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(pairBlocked("opencode", CONN, MODEL)).toBeNull();
  });

  it("antigravity keying stays MODEL-level (its quota is genuinely per-model)", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: {
        [MODEL]: { remainingPercentage: 50, resetAt: new Date(Date.now() + HOUR).toISOString() },
        "other-model": { remainingPercentage: 50, resetAt: new Date(Date.now() + HOUR).toISOString() },
      },
    });
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("antigravity", CONN, 429, "other-model", "tok", {})).toBeNull();
    // A strike on a DIFFERENT model must not advance MODEL's own count.
    expect(await handleProviderQuotaError("antigravity", CONN, 429, "other-model", "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(pairBlocked("antigravity", CONN, MODEL)).toBeNull();
    // The 3rd strike on MODEL itself does, and it is the 15m window (a quota
    // API reading that contradicts the endpoint is the dual-pool mismatch).
    const blockMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(blockMs).not.toBeNull();
    expect(blockMs).toBeGreaterThanOrEqual(Date.now() + 15 * 60_000 - 5_000);
  });

  it("a different CONNECTION is not poisoned by another's strikes (isolation is per connection)", async () => {
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {});
    expect(await handleProviderQuotaError("opencode", OTHER_CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", OTHER_CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", OTHER_CONN, 429, MODEL, "tok", {})).not.toBeNull();
  });

  it("a 409 counts toward the strike threshold (antigravity signals pool exhaustion with 409 too)", async () => {
    expect(await handleProviderQuotaError("opencode", CONN, 409, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("opencode", CONN, 429, MODEL, "tok", {})).toBeNull();
    const blockMs = await handleProviderQuotaError("opencode", CONN, 409, MODEL, "tok", {});
    expect(blockMs).not.toBeNull();
  });

  it("an optimistic quota reading counts as a strike (API can lie while the endpoint 429s)", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [MODEL]: { remainingPercentage: 50, resetAt: new Date(Date.now() + HOUR).toISOString() } },
    });
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    expect(await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {})).toBeNull();
    const blockMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(blockMs).not.toBeNull();
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

  it("throttles refreshes to one quota call per 30s per connection (no amplification)", async () => {
    mocks.getAntigravityUsage.mockResolvedValue({ quotas: {} });
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    const calls = mocks.getAntigravityUsage.mock.calls.length;
    await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(mocks.getAntigravityUsage.mock.calls.length).toBe(calls);
  });
});
