import { describe, it, expect, beforeEach, vi } from "vitest";

// END-TO-END guard for the live bug: 429 opencode-free via the noAuth pool
// path — strikes recorded under the connectionId chat actually used, then the
// pool picker must skip it (it did not: 7 429s in 13s, every 3rd one
// recording but never blocking).

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ providerStrategies: {} })),
  updateProviderConnection: vi.fn(async () => {}),
  getProxyPools: vi.fn(async () => [
    { id: "pool-a", isActive: true, testStatus: "active", name: "Direct Connection" },
  ]),
  updateProxyPool: vi.fn(async () => {}),
  getProxyPoolById: vi.fn(async () => null),
  resolveConnectionProxyConfig: vi.fn(async (d) => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "http://relay-a:8080",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
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

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const { handleProviderQuotaError, isPairBlocked, __resetProviderQuotaCache } =
  await import("../../src/sse/services/providerQuota.js");

const MODEL = "muse-spark-1.3-contributor-free";

describe("noAuth pool picker honors the strike breaker", () => {
  beforeEach(() => {
    __resetProviderQuotaCache();
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
  });

  it("a pool whose bare-noauth strikes reached threshold is skipped by the picker", async () => {
    // The picker picks pool-a and mint connectionId "noauth:pool-a"? No: the
    // auto-rotate path mints `noauth:<poolId>`; the legacy direct path mints
    // bare `noauth`. Both must be consulted. Record 3 strikes as the chat
    // handler would (bare "noauth", the Direct Connection shape), then ask the
    // picker — pool-a must be skipped because that connection+model pair is
    // blocked, and the result must report allRateLimited with a real retryAfter.
    await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});
    await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});
    const block = await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});
    expect(block).not.toBeNull();

    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds?.allRateLimited).toBe(true);
    expect(creds?.retryAfter).toBe(new Date(block).toISOString());
  });

  it("the PINNED-pool strategy (bare noauth) reports allRateLimited instead of minting again", async () => {
    // The live 429-storm shape: providerStrategies pins opencode to pool-a,
    // auth.js mints bare `noauth` on EVERY call with no rotation, and (before
    // this PR) never consulted the breaker — 7 429s in 13s, every 3rd one
    // recording but nothing blocking.
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { proxyPoolId: "pool-a" } },
      fallbackStrategy: "fill-first",
    });

    await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});
    await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});
    await handleProviderQuotaError("opencode", "noauth", 429, MODEL, "public", {});

    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds?.allRateLimited).toBe(true);
    expect(creds?.retryAfter).toBeTruthy();
    // The break must be the 5m strike-only window, not the generic 5s park.
    expect(new Date(creds.retryAfter).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
  });
});
