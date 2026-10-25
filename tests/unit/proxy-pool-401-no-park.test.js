import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the 2026-10-25 incident.
//
// ONE relay serves every provider. openrouter has no credential in this
// deployment, so every openrouter request through a relay answered
//
//   401 {"error":{"message":"Missing Authentication header","code":401}}
//
// The 401 rule in ERROR_RULES parks the account for 2 minutes, and for a
// virtual pool connection "the account" IS the shared relay row — so
// openrouter's missing key parked relay1 and cloudflare for 120s. opencode
// then had no eligible pool at all and repeated that 401 as ITS cause:
//
//   [AUTH] openrouter 401 → pool 602fdbbb parked
//   [AUTH] openrouter 401 → pool 811de521 parked
//   [AUTH] opencode | all proxy pools parked [401], retry after reset after 1m 51s
//   [CHAT]  [opencode/glm-5.3-flash-free] [401]: {"error":{"message":"Missing Authentication header"…}}
//
// opencode never sent an unauthorized request. A 401/403 is a verdict about
// the CALLER's credentials for one provider, never about the relay's health:
// the same relay rotates fine for a provider that HAS credentials.
//
// Pool-scoped faults (402 dead deployment, 429 quota, 5xx, suspend) must keep
// parking the relay — pinned below so the fix cannot be widened by accident.
//
// Real classifier + real ERROR_RULES: the ordering bug is invisible under a
// mocked checkFallbackError (same rationale as proxy-pool-410-no-park.test.js).

const settings = { providerStrategies: {} };
const proxyPools = [];
const poolWrites = [];

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
  getProxyPools: vi.fn(async () => proxyPools.filter((p) => p.isActive)),
  getProxyPoolById: vi.fn(async (id) => proxyPools.find((p) => p.id === id) || null),
  updateProxyPool: vi.fn(async (id, data) => {
    poolWrites.push({ id, ...data });
    const p = proxyPools.find((x) => x.id === id);
    if (p) Object.assign(p, data);
    return p || null;
  }),
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

vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
}));

// Import AFTER mocks. accountFallback + errorConfig are intentionally REAL.
const { getProviderCredentials, markAccountUnavailable } =
  await import("../../src/sse/services/auth.js");
const logger = await import("../../src/sse/utils/logger.js");

// The body openrouter returns for a relay call that carried no key, verbatim.
const MISSING_AUTH_BODY = JSON.stringify({ error: { message: "Missing Authentication header", code: 401 } });

function resetPools(...pools) {
  proxyPools.length = 0;
  poolWrites.length = 0;
  proxyPools.push(...pools.map((p) => ({ isActive: true, ...p })));
}

beforeEach(() => {
  settings.providerStrategies = {};
  resetPools();
  connectionProxyResolve.mockClear();
  logger.info.mockClear();
});

describe("401/403 is a caller-credential verdict, not a relay fault", () => {
  it("does not park the shared pool on a 401", async () => {
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });

    const r = await markAccountUnavailable("noauth:poolA", 401, MISSING_AUTH_BODY, "openrouter");

    // Rotating is right (another pool/account may hold the credential), but
    // the relay is healthy: nothing may be written to the pool row.
    expect(r.shouldFallback).toBe(true);
    expect(poolWrites).toHaveLength(0);
    expect(proxyPools.find((p) => p.id === "poolA").testStatus).toBeUndefined();
  });

  it("does not park the shared pool on a 403", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:poolA", 403, "forbidden", "openrouter");
    expect(r.shouldFallback).toBe(true);
    expect(poolWrites).toHaveLength(0);
  });

  it("keeps the relay selectable for a different provider after a 401", async () => {
    // The incident's blast radius: openrouter's 401 must not make the relay
    // ineligible for opencode. A 401 for one provider, then a healthy lookup
    // for another, must still hand out the same pool.
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });
    await markAccountUnavailable("noauth:poolA", 401, MISSING_AUTH_BODY, "openrouter");

    const creds = await getProviderCredentials("opencode", null, "glm-5.3-flash-free");
    expect(creds.id).toBe("noauth:poolA");
    expect(creds.allRateLimited).toBeUndefined();
  });

  it("still parks a 402 dead relay deployment", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:poolA", 402, "Payment required\n\nDEPLOYMENT_DISABLED", "opencode");
    expect(r.shouldFallback).toBe(true);
    await vi.waitFor(() => expect(poolWrites.length).toBeGreaterThan(0));
    expect(poolWrites.at(-1).testStatus).toBe("unavailable");
  });

  it("still parks a 429 relay quota", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:poolA", 429, "Rate limit exceeded", "opencode");
    expect(r.shouldFallback).toBe(true);
    await vi.waitFor(() => expect(poolWrites.length).toBeGreaterThan(0));
  });

  it("still parks a 503 suspended relay", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 503, "(USAGE_EXCEEDED) This application is suspended due to usage limits", "opencode");
    await vi.waitFor(() => expect(poolWrites.length).toBeGreaterThan(0));
  });
});

describe("an all-parked verdict is not a connection", () => {
  it("does not log a pool name for the allRateLimited verdict", async () => {
    // Every pool is parked, and the keyed connection is already excluded, so
    // the BYOK branch falls through to the virtual picker and gets the
    // verdict back. It used to be logged as a connection:
    //   [AUTH] Using opencode proxy pool: undefined
    resetPools({ id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: new Date(Date.now() + 60_000).toISOString() });

    const creds = await getProviderCredentials("opencode", new Set(["keyed-1"]), "glm-5.3-flash-free");

    expect(creds.allRateLimited).toBe(true);
    expect(creds.retryAfter).toBeTruthy();
    expect(logger.info.mock.calls.map((c) => c.join(" ")).join("\n"))
      .not.toMatch(/proxy pool: undefined/);
  });
});
