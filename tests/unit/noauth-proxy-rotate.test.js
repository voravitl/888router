import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks for auth.js dependencies ---
const settings = { providerStrategies: {} };
const proxyPools = [];
const connectionProxyResolve = vi.fn(async ({ proxyPoolId }) => ({
  connectionProxyEnabled: false,
  connectionProxyUrl: "",
  connectionNoProxy: "",
  proxyPoolId: proxyPoolId || null,
  vercelRelayUrl: proxyPoolId ? `https://relay-${proxyPoolId}.example.com` : "",
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => settings),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => ({ valid: false })),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: (...a) => connectionProxyResolve(...a),
}));

vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  getProxyPools: vi.fn(async () => proxyPools),
}));

vi.mock("open-sse/services/accountFallback.js", () => ({
  checkFallbackError: vi.fn((status) => {
    if (status === 429 || status === 402 || status >= 500) {
      return { shouldFallback: true, cooldownMs: 1000 };
    }
    return { shouldFallback: false, cooldownMs: 0 };
  }),
  formatRetryAfter: vi.fn(() => "1m"),
  isModelLockActive: vi.fn(() => false),
  buildModelLockUpdate: vi.fn(() => ({})),
  getEarliestModelLockUntil: vi.fn(() => null),
}));

vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 60_000,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((p) => p),
  FREE_PROVIDERS: { opencode: { noAuth: true } },
  AI_PROVIDERS: {},
}));

vi.mock("open-sse/services/quotaSnapshot.js", () => ({
  partitionByQuotaHealth: vi.fn((conns) => ({ healthy: conns })),
  QUOTA_AVOID_THRESHOLD_PCT: 0.9,
  QUOTA_SNAPSHOT_MAX_AGE_MS: 60_000,
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  pickByScore: vi.fn((pool) => ({ connection: pool[0], breakdown: { reason: "mock" } })),
}));

vi.mock("../utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// Import AFTER mocks registered.
const { getProviderCredentials, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const POOL_A = { id: "poolA", name: "A", isActive: true };
const POOL_B = { id: "poolB", name: "B", isActive: true };

describe("noAuth proxy pool auto-rotate", () => {
  beforeEach(() => {
    settings.providerStrategies = {};
    proxyPools.length = 0;
    connectionProxyResolve.mockClear();
  });

  it("returns one virtual connection per active pool with distinct ids", async () => {
    proxyPools.push(POOL_A, POOL_B);
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolA"); // first pool picked
    expect(creds.connectionId).toBe("noauth:poolA"); // must carry connectionId so chat.js can rotate pools on error
    expect(creds.connectionName).toContain("A");
  });

  it("rotates to next pool when the first is excluded", async () => {
    proxyPools.push(POOL_A, POOL_B);
    const exclude = new Set(["noauth:poolA"]);
    const creds = await getProviderCredentials("opencode", exclude, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolB");
  });

  it("returns null when all pools are excluded", async () => {
    proxyPools.push(POOL_A, POOL_B);
    const exclude = new Set(["noauth:poolA", "noauth:poolB"]);
    const creds = await getProviderCredentials("opencode", exclude, "deepseek-v4-flash-free");
    expect(creds).toBeNull();
  });

  it("single specific proxyPoolId uses legacy 'noauth' id (no rotation)", async () => {
    settings.providerStrategies = { opencode: { proxyPoolId: "poolA" } };
    const creds = await getProviderCredentials("opencode", new Set(["noauth:poolA"]), "deepseek-v4-flash-free");
    // Specific pool → id "noauth", unaffected by exclusion set.
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("poolA");
  });

  it("specific pool with no proxy/relay URL → null (no silent bad config)", async () => {
    settings.providerStrategies = { opencode: { proxyPoolId: "poolBroken" } };
    connectionProxyResolve.mockImplementation(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      vercelRelayUrl: "", // no URL → invalid
    }));
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds).toBeNull();
    // restore
    connectionProxyResolve.mockImplementation(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      vercelRelayUrl: proxyPoolId ? `https://relay-${proxyPoolId}.example.com` : "",
    }));
  });

  it("no active pools → falls back to direct connection 'noauth'", async () => {
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth");
  });

  it("active pools but all lack relay URL → fall back to direct (no silent outage)", async () => {
    proxyPools.push(POOL_A, POOL_B);
    connectionProxyResolve.mockImplementation(async () => ({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "", // all pools broken
    }));
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.vercelRelayUrl || creds.providerSpecificData.connectionProxyUrl).toBeFalsy();
    // restore
    connectionProxyResolve.mockImplementation(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      vercelRelayUrl: proxyPoolId ? `https://relay-${proxyPoolId}.example.com` : "",
    }));
  });

  it("integration: chat fallback loop rotates pool A(429) → B(success), then A→B exhausted → null", async () => {
    proxyPools.push(POOL_A, POOL_B);
    // Simulate chat.js while(true) loop: each iteration excludes the failed
    // pool (creds.id) and re-requests credentials.
    const exclude = new Set();

    // Hop 1 → pool A
    const c1 = await getProviderCredentials("opencode", exclude, "deepseek-v4-flash-free");
    expect(c1.id).toBe("noauth:poolA");
    expect(c1.connectionId).toBe("noauth:poolA"); // rotation relies on connectionId for markAccountUnavailable
    exclude.add(c1.id); // A failed (429)

    // Hop 2 → pool B
    const c2 = await getProviderCredentials("opencode", exclude, "deepseek-v4-flash-free");
    expect(c2.id).toBe("noauth:poolB");
    exclude.add(c2.id); // B also failed

    // Hop 3 → exhausted → null (loop ends, no infinite retry)
    const c3 = await getProviderCredentials("opencode", exclude, "deepseek-v4-flash-free");
    expect(c3).toBeNull();
  });
});

describe("markAccountUnavailable on auto-rotate pool", () => {
  it("rotates on 429 (rate limit)", async () => {
    const r = await markAccountUnavailable("noauth:poolA", 429, "Rate limit exceeded");
    expect(r.shouldFallback).toBe(true);
  });

  it("rotates on 402 (insufficient balance)", async () => {
    const r = await markAccountUnavailable("noauth:poolA", 402, "Insufficient Balance");
    expect(r.shouldFallback).toBe(true);
  });

  it("rotates on 5xx", async () => {
    const r = await markAccountUnavailable("noauth:poolA", 502, "Bad Gateway");
    expect(r.shouldFallback).toBe(true);
  });

  it("does NOT fall back on 4xx model errors (keeps pool)", async () => {
    const r = await markAccountUnavailable("noauth:poolA", 404, "model not found");
    expect(r.shouldFallback).toBe(false);
  });

  it("bare 'noauth' (single fixed) never falls back", async () => {
    const r = await markAccountUnavailable("noauth", 429, "Rate limit");
    expect(r.shouldFallback).toBe(false);
  });
});
