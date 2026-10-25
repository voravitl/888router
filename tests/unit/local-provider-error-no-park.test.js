import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-10-25, observed live on 0.15.192:
//
//   [AUTH] Using cloudflare-ai account: Public:vercel-relay1
//   [ERROR] [502]: cloudflare-ai requires accountId in providerSpecificData
//   [AUTH] pool 602fdbbb parked 30s [502]
//   [AUTH] Using cloudflare-ai account: Public:cloudflare-relay
//   [ERROR] [502]: cloudflare-ai requires accountId in providerSpecificData
//   [AUTH] pool 811de521 parked 30s [502]
//   [AUTH] cloudflare-ai | all proxy pools parked [502], retry after reset after 30s
//
// The upstream was never contacted. `DefaultExecutor.buildUrl` throws before
// the fetch because the connection has no `accountId` — a LOCAL CONFIG error
// dressed up as a 502 by the catch-all in chatCore.
//
// The consequences are not local:
//   - the shared relay is parked for 30 s, so every OTHER provider loses it;
//   - the SAME request is retried against every other relay, each failing the
//     same way (no accountId anywhere), and every one of those failures parks
//     another relay — so one unconfigured provider takes the whole relay pool
//     out of rotation for half a minute;
//   - the client is told "all proxy pools parked [502]", a relay verdict for
//     something that never left the machine.
//
// A local failure is the caller's/provider's configuration, never the relay's
// health, and never another provider's problem. Pinned below:
//   1. a local error does not park the relay;
//   2. it does not park (pool, provider) either — there is nothing to recover
//      from, the next request fails identically;
//   3. the client still gets a clear, non-retryable error.

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
  FREE_PROVIDERS: { opencode: { noAuth: true }, "cloudflare-ai": { noAuth: true } },
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

const { markAccountUnavailable, getProviderCredentials } =
  await import("../../src/sse/services/auth.js");
const { isLocalProviderError } = await import("../../open-sse/utils/error.js");

// The message DefaultExecutor.buildUrl throws, verbatim.
const LOCAL_CONFIG_ERROR = "[502]: cloudflare-ai requires accountId in providerSpecificData";

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

describe("a local provider error is recognised as local", () => {
  it("flags the accountId config error", () => {
    expect(isLocalProviderError("cloudflare-ai requires accountId in providerSpecificData")).toBe(true);
  });

  it("flags the other local-only failures", () => {
    expect(isLocalProviderError("Machine ID is required for the Cursor API")).toBe(true);
    expect(isLocalProviderError("Devin CLI bridge is disabled by default")).toBe(true);
    expect(isLocalProviderError("AiPASS Chrome extension not connected")).toBe(true);
  });

  it("does not flag an upstream failure", () => {
    expect(isLocalProviderError("fetch connect timeout")).toBe(false);
    expect(isLocalProviderError("FreeUsageLimitError")).toBe(false);
    expect(isLocalProviderError("[502]: Bad gateway")).toBe(false);
    expect(isLocalProviderError("Payment required\n\nDEPLOYMENT_DISABLED")).toBe(false);
    expect(isLocalProviderError("(USAGE_EXCEEDED) This application is suspended")).toBe(false);
  });
});

describe("a local error must not park the shared relay", () => {
  it("leaves the pool row untouched", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:poolA", 502, LOCAL_CONFIG_ERROR, "cloudflare-ai", "@cf/meta/llama-3.2-3b-instruct");
    expect(poolWrites).toHaveLength(0);
    expect(proxyPools[0].testStatus).toBeUndefined();
    expect(proxyPools[0].providerParks).toBeUndefined();
    // The request is not retryable against another relay either — it would
    // fail identically, so rotation must stop.
    expect(r.shouldFallback).toBe(false);
  });

  it("keeps the relay available for a provider that is configured", async () => {
    resetPools({ id: "poolA", name: "A" });
    await markAccountUnavailable("noauth:poolA", 502, LOCAL_CONFIG_ERROR, "cloudflare-ai", "@cf/meta/llama-3.2-3b-instruct");

    const creds = await getProviderCredentials("opencode", null, "glm-5.3-flash-free");
    expect(creds.id).toBe("noauth:poolA");
  });

  it("does not lock a real account on a local error", async () => {
    // The keyed-account branch of markAccountUnavailable must not write a
    // modelLock_* either: the account is healthy, its configuration is not.
    const { updateProviderConnection } = await import("@/lib/localDb");
    updateProviderConnection.mockClear();
    const r = await markAccountUnavailable("conn-1", 502, LOCAL_CONFIG_ERROR, "cloudflare-ai", "@cf/meta/llama-3.2-3b-instruct");
    expect(r.shouldFallback).toBe(false);
    expect(r.localProviderError).toBe(true);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("the executor flags a local error at its source", () => {
  it("marks the accountId error as local", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("cloudflare-ai");
    let err = null;
    try {
      ex.buildUrl("@cf/meta/llama-3.2-3b-instruct", true, 0, { providerSpecificData: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.localProviderError).toBe(true);
    expect(isLocalProviderError(err.message)).toBe(true);
  });
});
