import { describe, it, expect, beforeEach, vi } from "vitest";

// Guards the AUTH half of the quota-routing fix (issue #487):
//  - the pre-filter must skip a connection whose cached quota is exhausted,
//    and report the REAL window in the all-rate-limited response (the
//    persisted modelLock is capped at 30m and cannot carry an 80h window);
//  - the antigravity executor must surface resetsAtMs from RetryInfo /
//    ErrorInfo / message text, because parseUpstreamError only forwards
//    { status, message, resetsAtMs } — a bare retryAfter or the details[]
//    array is dropped, and chatCore's re-wrap then leaves nothing but text.

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
  updateProviderConnection: vi.fn(async () => {}),
  getProxyPools: vi.fn(async () => []),
  updateProxyPool: vi.fn(async () => {}),
  getProxyPoolById: vi.fn(async () => null),
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    vercelRelayUrl: "", strictProxy: false,
  })),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  getProxyPools: mocks.getProxyPools,
  updateProxyPool: mocks.updateProxyPool,
  getProxyPoolById: mocks.getProxyPoolById,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
// The quota handler refreshes the live API before consulting the cache; without
// this mock the real fetch runs and the exhausted reading never lands.
mocks.getAntigravityUsage = vi.fn(async () => ({
  quotas: { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() + 80 * HOUR).toISOString() } },
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { handleProviderQuotaError, __resetProviderQuotaCache, getProviderQuotaCache } =
  await import("../../src/sse/services/providerQuota.js");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");

const CONN = "aaaa1111-0000-0000-0000-000000000000";
const MODEL = "claude-sonnet-4-6";
const HOUR = 3600_000;

function connection(overrides = {}) {
  return {
    id: CONN,
    provider: "antigravity",
    isActive: true,
    testStatus: "active",
    displayName: "AG test account",
    accessToken: "tok",
    providerSpecificData: {},
    ...overrides,
  };
}

describe("auth pre-filter — quota cache channel", () => {
  beforeEach(() => {
    __resetProviderQuotaCache();
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([connection()]);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
  });

  it("skips a connection whose cached quota is exhausted for this model", async () => {
    const until = new Date(Date.now() + 2 * HOUR).toISOString();
    getProviderQuotaCache().set(CONN, { [MODEL]: { remainingPercentage: 0, resetAt: until } });

    const creds = await getProviderCredentials("antigravity", null, MODEL);

    // Only account is cache-exhausted → all skipped.
    expect(creds).not.toBeNull();
    expect(creds.allRateLimited).toBe(true);
  });

  it("does NOT skip a connection whose cache entry has a PAST resetAt", async () => {
    getProviderQuotaCache().set(CONN, { [MODEL]: { remainingPercentage: 0, resetAt: new Date(Date.now() - 1000).toISOString() } });
    const creds = await getProviderCredentials("antigravity", null, MODEL);
    expect(creds?.connectionId).toBe(CONN);
  });

  it("reports the REAL window (80h) in the all-rate-limited response, not the 30m lock cap", async () => {
    const until = new Date(Date.now() + 80 * HOUR).toISOString();
    getProviderQuotaCache().set(CONN, { [MODEL]: { remainingPercentage: 0, resetAt: until } });

    const creds = await getProviderCredentials("antigravity", null, MODEL);
    expect(creds?.allRateLimited).toBe(true);
    expect(creds?.retryAfter).toBe(until);
  });

  it("is a no-op for a provider that is not quota-tracked", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection({ provider: "openai", id: "999" })]);
    const creds = await getProviderCredentials("openai", null, MODEL);
    expect(creds?.connectionId).toBe("999");
    expect(getProviderQuotaCache().size).toBe(0);
  });
});

describe("antigravity executor parseError → resetsAtMs", () => {
  const response = (status) => ({ status, headers: {} });

  beforeEach(() => {
    __resetProviderQuotaCache();
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([connection()]);
  });

  it("RetryInfo.retryDelay (duration seconds) becomes a future resetsAtMs", () => {
    const ex = new AntigravityExecutor();
    const body = JSON.stringify({
      error: {
        message: "Individual quota reached. Resets in 80h25m39s.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "289539.38s" }],
      },
    });
    const parsed = ex.parseError(response(429), body);
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 79 * HOUR);
    expect(parsed.resetsAtMs).toBeLessThan(Date.now() + 81 * HOUR);
  });

  it("ErrorInfo.quotaResetTimeStamp (ISO instant) becomes resetsAtMs", () => {
    const ex = new AntigravityExecutor();
    const ts = new Date(Date.now() + 5 * HOUR).toISOString();
    const body = JSON.stringify({
      error: {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetTimeStamp: ts } }],
      },
    });
    const parsed = ex.parseError(response(429), body);
    expect(parsed.resetsAtMs).toBe(new Date(ts).getTime());
  });

  it("message text is the fallback when details[] carry nothing usable", () => {
    const ex = new AntigravityExecutor();
    const parsed = ex.parseError(response(429), "Individual quota reached. Resets in 80h25m39s.");
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 79 * HOUR);
  });

  it("a PAST quotaResetTimeStamp is ignored rather than producing a negative window", () => {
    const ex = new AntigravityExecutor();
    const past = new Date(Date.now() - HOUR).toISOString();
    const body = JSON.stringify({
      error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quotaResetTimeStamp: past } }] },
    });
    const parsed = ex.parseError(response(429), body);
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("non-429/409 statuses are left untouched", () => {
    const ex = new AntigravityExecutor();
    const parsed = ex.parseError(response(500), JSON.stringify({ error: { details: [{ "@type": "RetryInfo", retryDelay: "10s" }] } }));
    expect(parsed.resetsAtMs).toBeUndefined();
  });

  it("end to end: a 429 through the quota handler reaches the pre-filter within the same request cycle", async () => {
    // Simulates the chat handler path: 429 → handleProviderQuotaError → the
    // pre-filter (getProviderCredentials) must see the pair as blocked.
    const ex = new AntigravityExecutor();
    const body = JSON.stringify({
      error: {
        message: "Individual quota reached. Resets in 80h.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "289539.38s" }],
      },
    });
    const parsed = ex.parseError(response(429), body);
    const resetMs = await handleProviderQuotaError("antigravity", CONN, 429, MODEL, "tok", {});
    expect(parsed.resetsAtMs).not.toBeNull();
    expect(resetMs).not.toBeNull();

    const creds = await getProviderCredentials("antigravity", null, MODEL);
    expect(creds?.allRateLimited).toBe(true);
  });
});
