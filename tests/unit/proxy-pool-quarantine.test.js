import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the relay-suspend rotation bug: a proxy pool whose host
// suspended it for exceeding a usage quota (Deno Deploy / Vercel 503
// USAGE_EXCEEDED) was handed back by rotation within seconds, indefinitely —
// observed as the same dead relay being picked 754 times in 3 hours while a
// healthy pool sat unused.
//
// Two independent causes, both covered here:
//   1. ERROR_RULES ordering — "usage limit" (backoff) matched the suspend
//      message ("...usage limits being exceeded") before the suspend rule did,
//      so a suspended relay was classified as an escalating rate limit.
//   2. Nothing persisted the failure on the pool row, and the backoff level was
//      passed as a hardcoded 0, so the park window never grew.
//
// Unlike the other proxy tests in this directory, this file uses the REAL
// classifier + error config — the ordering bug is invisible under a mocked
// checkFallbackError.

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

vi.mock("../utils/logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
}));

// Import AFTER mocks. accountFallback + errorConfig are intentionally REAL.
const { getProviderCredentials, markAccountUnavailable, clearAccountError } =
  await import("../../src/sse/services/auth.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { POOL_SUSPEND_PARK_MS } = await import("../../open-sse/config/errorConfig.js");

// Verbatim body Deno Deploy returns for a quota-suspended deployment.
const DENO_SUSPEND = [
  "503: Service Unavailable (USAGE_EXCEEDED)",
  "This application is suspended due to usage limits being exceeded.",
  "Deno Deploy encountered an error while processing this request.",
].join("\n");

const MIN = 60 * 1000;
const future = (ms) => new Date(Date.now() + ms).toISOString();
const past = (ms) => new Date(Date.now() - ms).toISOString();

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

describe("relay-suspend classification (real ERROR_RULES)", () => {
  it("suspend rule wins over the generic 'usage limit' backoff rule", () => {
    // The bug: "...usage limits being exceeded" also matches { text: "usage
    // limit", backoff: true }. First-match-wins meant the suspend rule never
    // ran, pinning a dead relay to the level-1 backoff value (2s).
    const r = checkFallbackError(503, DENO_SUSPEND, 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.parkMs).toBe(POOL_SUSPEND_PARK_MS);
    expect(r.newBackoffLevel).toBeUndefined(); // not treated as a rate limit
  });

  it("park window is long enough to actually leave rotation", () => {
    // 2s (the old value) is shorter than a single request, so the pool came
    // straight back. A quota window resets in hours, not seconds.
    expect(checkFallbackError(503, DENO_SUSPEND, 0).parkMs).toBeGreaterThanOrEqual(10 * MIN);
  });

  it("hop cooldown stays short so combo still rotates fast within one request", () => {
    // combo.js waits out cooldownMs before falling through on a transient 5xx;
    // a long value here would stall the request instead of rotating.
    expect(checkFallbackError(503, DENO_SUSPEND, 0).cooldownMs).toBeLessThanOrEqual(5000);
  });

  it("does not regress genuine rate limits into a fixed park", () => {
    const r = checkFallbackError(429, "rate limit exceeded", 3);
    expect(r.newBackoffLevel).toBe(4);
    expect(r.parkMs).toBeUndefined();
  });
});

describe("pool quarantine on failure", () => {
  it("parks a suspended relay for the long window, not the hop cooldown", async () => {
    resetPools({ id: "poolA", name: "A" });
    const before = Date.now();
    const r = await markAccountUnavailable("noauth:poolA", 503, DENO_SUSPEND, "opencode");
    expect(r.shouldFallback).toBe(true); // still rotates away right now
    await vi.waitFor(() => expect(poolWrites.length).toBeGreaterThan(0));

    const w = poolWrites.at(-1);
    expect(w.id).toBe("poolA");
    expect(w.testStatus).toBe("unavailable");
    const parkedMs = new Date(w.unavailableUntil).getTime() - before;
    expect(parkedMs).toBeGreaterThanOrEqual(10 * MIN);
  });

  it("escalates the park window across repeated rate-limit failures", async () => {
    // The backoff level lives on the pool row: a virtual noauth: connection has
    // no providerConnections row to hold it. Passing a hardcoded 0 (the bug)
    // pinned every failure to level 1 forever.
    resetPools({ id: "poolA", name: "A" });
    const levels = [];
    for (let i = 0; i < 3; i++) {
      await markAccountUnavailable("noauth:poolA", 429, "rate limit exceeded", "opencode");
      await vi.waitFor(() => expect(poolWrites.length).toBe(i + 1));
      levels.push(poolWrites.at(-1).backoffLevel);
    }
    expect(levels).toEqual([1, 2, 3]);
  });

  it("ignores a malformed 'noauth:' id instead of writing to every pool", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:", 503, DENO_SUSPEND, "opencode");
    expect(r.shouldFallback).toBe(true);
    expect(poolWrites).toHaveLength(0);
  });
});

describe("rotation skips parked pools", () => {
  it("never re-selects a transient-5xx pool before its 30s park elapses", async () => {
    // The regression this whole feature exists for: a Vercel relay that 504'd
    // needs ~20s to recover, but with no parkMs on the status rules it was
    // parked for cooldownMs (5s) and handed straight back — combo burned the
    // wait, then fell through to the next provider while the relay was still
    // down. Park the relay, then assert selection skips it for the full window.
    resetPools(
      { id: "poolA", name: "A" },
      { id: "poolB", name: "B" },
    );
    await markAccountUnavailable("noauth:poolA", 504, "An error occurred with your deployment", "opencode");
    await vi.waitFor(() => expect(poolWrites.length).toBe(1));

    const parkedUntil = new Date(poolWrites[0].unavailableUntil).getTime();
    const windowMs = parkedUntil - Date.now();
    expect(windowMs).toBeGreaterThanOrEqual(25_000); // ~30s park, not 5s

    // poolA is parked → the FIRST eligible pick must be poolB, and it must
    // stay that way until the window elapses.
    for (let i = 0; i < 3; i++) {
      const creds = await getProviderCredentials("opencode", new Set(["noauth:seed"]), "deepseek-v4-flash-free");
      expect(creds.id).toBe("noauth:poolB");
    }
    expect(proxyPools.find((p) => p.id === "poolA").testStatus).toBe("unavailable");
  });

  it("skips a pool still inside its park window", async () => {
    resetPools(
      { id: "poolDead", name: "Dead", testStatus: "unavailable", unavailableUntil: future(20 * MIN) },
      { id: "poolLive", name: "Live" },
    );
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolLive");
  });

  it("does NOT re-admit a stale-unavailable pool until it is seen working again", async () => {
    // Window expired but testStatus is still "unavailable" = the pool failed
    // and has not been observed working since. Re-admitting it here would let
    // a stale-unavailable pool back into rotation while a single active relay
    // carries every request (the rotation-stuck-on-relay2 bug). Only
    // clearAccountError — a successful request through the pool — flips it
    // back to "active".
    resetPools(
      { id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: past(MIN) },
      { id: "poolB", name: "B", testStatus: "active" },
    );
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolB");
    expect(poolWrites).toHaveLength(0); // selection is a read
  });

  it("returns null when every pool is parked rather than reusing a dead one", async () => {
    // The whole point of the fix: exhausted must mean exhausted. Handing back a
    // pool known to be suspended is what produced the endless retry loop.
    resetPools(
      { id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: future(20 * MIN) },
      { id: "poolB", name: "B", testStatus: "unavailable", unavailableUntil: future(20 * MIN) },
    );
    const creds = await getProviderCredentials("opencode", new Set(["noauth:seed"]), "deepseek-v4-flash-free");
    expect(creds).toBeNull();
  });
});

describe("pool health reset on success", () => {
  it("clears park state and backoff level after a request succeeds", async () => {
    resetPools({
      id: "poolA", name: "A", testStatus: "unavailable",
      lastError: "503 USAGE_EXCEEDED", unavailableUntil: future(20 * MIN), backoffLevel: 4,
    });
    await clearAccountError("noauth:poolA", {}, "deepseek-v4-flash-free");

    const w = poolWrites.at(-1);
    expect(w.testStatus).toBe("active");
    expect(w.lastError).toBeNull();
    expect(w.unavailableUntil).toBeNull();
    expect(w.backoffLevel).toBe(0);
  });

  it("does not write when the pool is already healthy", async () => {
    resetPools({ id: "poolA", name: "A", testStatus: "active" });
    await clearAccountError("noauth:poolA", {}, "deepseek-v4-flash-free");
    expect(poolWrites).toHaveLength(0);
  });
});

describe("all-stale-unavailable pools", () => {
  it("re-admits a stale-unavailable pool when no healthy pool remains", async () => {
    // Review round 2: a stale pool whose window lapsed must be re-admitted
    // when nothing healthy is left — otherwise clearAccountError can never
    // fire (the pool is never selected), every relay gets quarantined
    // forever, and the system hard-outages.
    resetPools(
      { id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: past(MIN) },
      { id: "poolB", name: "B", testStatus: "unavailable", unavailableUntil: past(MIN) },
    );
    const creds = await getProviderCredentials("opencode", new Set(["noauth:seed"]), "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolA"); // stale re-admitted, not null
  });

  it("prefers a healthy pool over stale ones", async () => {
    resetPools(
      { id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: past(MIN) },
      { id: "poolB", name: "B", testStatus: "active" },
    );
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolB");
  });
});

describe("healthy-URL-fail falls through to stale", () => {
  it("tries stale pool when healthy pool has no usable URL", async () => {
    // Review finding (round 3): `healthy.length > 0 ? healthy : stale`
    // skipped stale entirely when healthy pools existed but all failed URL
    // resolution → returned null instead of trying the stale pool that may
    // have a good URL. The merged single pass fixes it.
    const healthyNoUrl = { id: "poolA", name: "A", testStatus: "active" };
    const staleGoodUrl = { id: "poolB", name: "B", testStatus: "unavailable", unavailableUntil: past(MIN) };
    resetPools(healthyNoUrl, staleGoodUrl);
    connectionProxyResolve.mockImplementation(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      vercelRelayUrl: proxyPoolId === "poolB" ? "https://relay-poolB.example.com" : "",
    }));
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds.id).toBe("noauth:poolB");
  });
});

describe("multiple healthy pools", () => {
  it("selects each healthy pool across calls (rotation, not sticky)", async () => {
    // Review (round 4): two healthy pools — first call picks poolA, then
    // excluding it must yield poolB, proving rotation is not stuck on one.
    connectionProxyResolve.mockImplementation(async ({ proxyPoolId }) => ({
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
      proxyPoolId: proxyPoolId || null,
      vercelRelayUrl: proxyPoolId ? `https://relay-${proxyPoolId}.example.com` : "",
    }));
    resetPools(
      { id: "poolA", name: "A", testStatus: "active" },
      { id: "poolB", name: "B", testStatus: "active" },
    );
    const first = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(["noauth:poolA", "noauth:poolB"]).toContain(first.id);
    const second = await getProviderCredentials("opencode", new Set([first.id]), "deepseek-v4-flash-free");
    expect(second).not.toBeNull();
    expect(second.id).not.toBe(first.id); // rotated to the other pool
  });
});

describe("all-stale-no-URL", () => {
  it("returns null (exhausted) when stale pools all lack a usable URL", async () => {
    // Review (final): CHANGELOG claims "all-stale with no usable URL →
    // exhausted (null), not a silent bypass to direct" — pin it.
    connectionProxyResolve.mockImplementation(async () => ({
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
      proxyPoolId: null, vercelRelayUrl: "", // every pool URL-less
    }));
    resetPools(
      { id: "poolA", name: "A", testStatus: "unavailable", unavailableUntil: past(MIN) },
      { id: "poolB", name: "B", testStatus: "unavailable", unavailableUntil: past(MIN) },
    );
    const creds = await getProviderCredentials("opencode", null, "deepseek-v4-flash-free");
    expect(creds).toBeNull();
  });
});
