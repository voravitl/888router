import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-10-25 live evidence: one relay serves every provider, and the park
// record was TRANSPORT-scoped while the verdicts that write it are
// PROVIDER-scoped. Reproduced on the running gateway:
//
//   [AUTH] Using mmf proxy pool: Public:cloudflare-relay
//   [AUTH] Account Public:cloudflare-relay unavailable (401)          ← not parked (good)
//   [AUTH] Using mmf proxy pool: Public:vercel-relay2
//   [AUTH] pool f9c8c4cd parked 120s [402] backoff=0                  ← transport fault
//   [AUTH] mimo-free | all proxy pools parked [400]                   ← status from ANOTHER provider
//
// and in the other direction, opencode's free-tier 429 parked the relay that
// mimo-free had to use:
//
//   [AUTH] pool 811de521 parked 5s [429]
//   [AUTH] opencode | all proxy pools parked [429], retry after reset after 4s
//
// The upstream 429 for that request carried `retry-after: 76074` (21h, the
// daily free-tier reset). The gateway dropped it and told the client 4s.
//
// So two invariants, pinned below:
//   1. A provider's quota/credential verdict parks (pool, provider), never the
//      relay itself — the relay is still healthy for every other provider.
//   2. A transport verdict (dead deployment, suspended relay, 5xx) still parks
//      the relay for everyone.
//   3. A provider-reported Retry-After is honoured instead of the 5s hop
//      cooldown, capped so a hostile/buggy header cannot park for a year.

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

// Two noAuth providers share one relay, exactly like opencode + mimo-free.
vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((p) => p),
  FREE_PROVIDERS: { opencode: { noAuth: true }, mmf: { noAuth: true } },
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

const { getProviderCredentials, markAccountUnavailable, clearAccountError } =
  await import("../../src/sse/services/auth.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { POOL_SUSPEND_PARK_MS, MAX_RATE_LIMIT_COOLDOWN_MS } =
  await import("../../open-sse/config/errorConfig.js");

// Verbatim upstream body for the opencode free-tier wall.
const FREE_USAGE_BODY = JSON.stringify({
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go" },
});

function resetPools(...pools) {
  proxyPools.length = 0;
  poolWrites.length = 0;
  proxyPools.push(...pools.map((p) => ({ isActive: true, ...p })));
}

beforeEach(() => {
  settings.providerStrategies = {};
  resetPools();
  connectionProxyResolve.mockClear();
});

describe("checkFallbackError decides who owns the fault", () => {
  const scopeOf = (status, text) => checkFallbackError(status, text, 0).parkScope;

  it("treats a provider quota wall as a provider fault", () => {
    expect(scopeOf(429, FREE_USAGE_BODY)).toBe("provider");
    expect(scopeOf(429, "Rate limit exceeded")).toBe("provider");
    expect(scopeOf(402, "Payment required: your credits are exhausted")).toBe("provider");
  });

  it("treats a dead deployment / suspended relay as a transport fault", () => {
    expect(scopeOf(402, "Payment required\n\nDEPLOYMENT_DISABLED")).toBe("pool");
    expect(scopeOf(503, "(USAGE_EXCEEDED) This application is suspended due to usage limits")).toBe("pool");
    expect(scopeOf(502, "Bad gateway")).toBe("pool");
    expect(scopeOf(504, "Gateway timeout")).toBe("pool");
  });

  it("treats an unclassified 5xx as the relay's fault", () => {
    expect(scopeOf(500, "boom")).toBe("pool");
  });
});

describe("a provider verdict must not quarantine a shared relay", () => {
  it("parks (pool, provider), not the pool row, on a free-tier 429", async () => {
    resetPools({ id: "poolA", name: "A" });

    const r = await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free");

    expect(r.shouldFallback).toBe(true);
    const pool = proxyPools.find((p) => p.id === "poolA");
    expect(pool.testStatus).toBeUndefined();
    expect(pool.unavailableUntil).toBeUndefined();
    expect(pool.providerParks.opencode.models["glm-5.3-flash-free"].until).toBeTruthy();
  });

  it("still hands the relay to a DIFFERENT provider after another provider's 429", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free");

    const creds = await getProviderCredentials("mmf", null, "mimo-auto");
    expect(creds.id).toBe("noauth:poolA");
    expect(creds.allRateLimited).toBeUndefined();
  });

  it("still skips the relay for the provider that hit the wall", async () => {
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free");

    const creds = await getProviderCredentials("opencode", null, "glm-5.3-flash-free");
    expect(creds.id).toBe("noauth:poolB");
  });

  it("keeps the transport park global: a dead deployment is out for everyone", async () => {
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });
    await markAccountUnavailable("noauth:poolA", 402, "Payment required\n\nDEPLOYMENT_DISABLED", "opencode");

    const pool = proxyPools.find((p) => p.id === "poolA");
    expect(pool.testStatus).toBe("unavailable");
    // Not the 120s generic 402 cooldown: a disabled deployment does not come
    // back in two minutes, so it must not re-enter rotation on that clock.
    const parkMs = new Date(pool.unavailableUntil).getTime() - Date.now();
    expect(parkMs).toBeGreaterThan(POOL_SUSPEND_PARK_MS - 60_000);

    const creds = await getProviderCredentials("mmf", null, "mimo-auto");
    expect(creds.id).toBe("noauth:poolB");
  });
});

describe("the upstream Retry-After is the honest park window", () => {
  it("parks the provider for the reported window, not the 5s hop cooldown", async () => {
    resetPools({ id: "poolA", name: "A" });
    const resetsAtMs = Date.now() + 21 * 3600 * 1000;

    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free", resetsAtMs);

    const park = proxyPools.find((p) => p.id === "poolA").providerParks.opencode.models["glm-5.3-flash-free"];
    const parkMs = new Date(park.until).getTime() - Date.now();
    // Capped by MAX_RATE_LIMIT_COOLDOWN_MS so a hostile header cannot park
    // the provider for a year, but far above the 5s that caused the retry storm.
    expect(parkMs).toBeGreaterThan(MAX_RATE_LIMIT_COOLDOWN_MS - 60_000);
    expect(parkMs).toBeLessThanOrEqual(MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it("reports the provider park in the all-parked verdict, with its own status", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free", Date.now() + 600_000);

    const creds = await getProviderCredentials("opencode", new Set(["keyed-1"]), "glm-5.3-flash-free");
    expect(creds.allRateLimited).toBe(true);
    const waitMs = new Date(creds.retryAfter).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(60_000);
    // The verdict must describe THIS provider's failure, not whichever other
    // provider last touched the pool row (the live `[400]`/`[429]` mix-up).
    expect(creds.lastErrorCode).toBe(429);
    expect(creds.lastError).toMatch(/FreeUsageLimitError/);
  });
});

describe("recovery clears the provider park", () => {
  it("clears the provider park on a successful request through that pool", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free");
    expect(proxyPools[0].providerParks.opencode.models["glm-5.3-flash-free"]).toBeTruthy();

    await clearAccountError("noauth:poolA", { provider: "opencode", model: "glm-5.3-flash-free" }, "glm-5.3-flash-free");

    expect(proxyPools[0].providerParks?.opencode).toBeUndefined();
  });

  it("keeps a sibling model's park when another model succeeds", async () => {
    // The quota wall is per MODEL (providerQuota.js): `muse-spark` can be dead
    // while `space-bunny` still serves on the same account through the same
    // relay. A success on one model must not clear the other's park.
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "dead-model");
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "other-model");

    await clearAccountError("noauth:poolA", { provider: "opencode", model: "live-model" }, "live-model");

    const parks = proxyPools[0].providerParks.opencode.models;
    expect(parks["dead-model"]).toBeTruthy();
    expect(parks["other-model"]).toBeTruthy();
  });

  it("does not clear another provider's park on the same relay", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "glm-5.3-flash-free");
    await markAccountUnavailable("noauth:poolA", 402, "Payment required: credits exhausted", "mmf", "mimo-auto");

    await clearAccountError("noauth:poolA", { provider: "opencode", model: "glm-5.3-flash-free" }, "glm-5.3-flash-free");

    expect(proxyPools[0].providerParks.opencode).toBeUndefined();
    expect(proxyPools[0].providerParks.mmf).toBeTruthy();
  });
});

describe("a model-scoped park does not block the provider's siblings", () => {
  it("keeps a healthy sibling model on the same relay usable", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 429, FREE_USAGE_BODY, "opencode", "dead-model");

    // The dead model is skipped…
    const dead = await getProviderCredentials("opencode", null, "dead-model");
    expect(dead.allRateLimited).toBe(true);

    // …but a sibling model on the SAME relay still gets it.
    const live = await getProviderCredentials("opencode", null, "live-model");
    expect(live.id).toBe("noauth:poolA");
  });
});
