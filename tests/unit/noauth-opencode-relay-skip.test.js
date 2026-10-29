import { describe, it, expect, vi, beforeEach } from "vitest";

// OpenCode Free must never ride a vercel/cloudflare/deno RELAY pool: the relay
// originates its own TLS, so the cipher-list ClientHello the free tier gates
// on cannot pass through it (probe 2026-10-29: native TLS → 429
// FreeUsageLimitError, wreq-js cipher list → 200; live log showed
// `conn=Public:cloudflare-relay` → 429 and the relay parked 1800s for
// opencode). The picker must skip relay pools for opencode — before the
// "all pools parked" verdict — while HTTP proxy pools stay eligible and every
// other noAuth provider keeps using relays exactly as before.

const settings = { providerStrategies: {} };
const proxyPools = [];

const RELAY_TYPES = new Set(["vercel", "cloudflare", "deno"]);
// Mirrors src/lib/network/connectionProxy.js: a relay pool resolves to
// vercelRelayUrl (source = pool type), an HTTP pool to connectionProxyUrl.
const connectionProxyResolve = vi.fn(async ({ proxyPoolId }) => {
  const pool = proxyPools.find((p) => p.id === proxyPoolId);
  if (!pool) {
    return { source: "none", connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "", proxyPoolId: null, proxyPool: null };
  }
  if (RELAY_TYPES.has(pool.type)) {
    return {
      source: pool.type,
      proxyPoolId,
      proxyPool: pool,
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: pool.proxyUrl,
    };
  }
  return {
    source: "pool",
    proxyPoolId,
    proxyPool: pool,
    connectionProxyEnabled: true,
    connectionProxyUrl: pool.proxyUrl,
    connectionNoProxy: "",
  };
});

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
  getProxyPoolById: vi.fn(async (id) => proxyPools.find((p) => p.id === id) || null),
  updateProxyPool: vi.fn(async () => null),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: vi.fn((p) => p),
  FREE_PROVIDERS: { opencode: { noAuth: true }, "mimo-free": { noAuth: true } },
  AI_PROVIDERS: {},
}));

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => logMock);

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const MODEL = "deepseek-v4.1-flash-free";
const relayPool = (extra = {}) => ({
  id: "relay-cf",
  name: "cloudflare-relay",
  type: "cloudflare",
  proxyUrl: "https://cloudflare-relay.example.workers.dev",
  isActive: true,
  testStatus: "active",
  ...extra,
});
const httpPool = (id = "http-a", extra = {}) => ({
  id,
  name: id,
  type: "http",
  proxyUrl: `http://${id}:8080`,
  isActive: true,
  testStatus: "active",
  ...extra,
});

describe("opencode free lane never rides a relay pool", () => {
  beforeEach(() => {
    settings.providerStrategies = {};
    proxyPools.length = 0;
    connectionProxyResolve.mockClear();
    for (const fn of Object.values(logMock)) fn.mockClear();
  });

  it("(1) opencode + only a cloudflare relay pool → Direct, no vercelRelayUrl", async () => {
    // The live shape: the relay is ALSO parked for opencode — that must not
    // turn into "all proxy pools parked" (allRateLimited); the relay simply is
    // not a candidate, so the lane goes Direct.
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    proxyPools.push(relayPool({
      providerParks: { opencode: { until: future, status: 429, lastError: "[429]: FreeUsageLimitError" } },
    }));
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds?.allRateLimited).toBeUndefined();
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBeNull();
    // The relay was never resolved (skipped cheaply on pool.type).
    expect(connectionProxyResolve).not.toHaveBeenCalled();
  });

  it("(2) opencode + relay + http proxy pool → the http pool", async () => {
    proxyPools.push(relayPool(), httpPool("http-a"));
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.id).toBe("noauth:http-a");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("http://http-a:8080");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("");
    expect(connectionProxyResolve).toHaveBeenCalledTimes(1);
    expect(connectionProxyResolve).toHaveBeenCalledWith({ proxyPoolId: "http-a" });
  });

  it("(3) opencode pinned to a relay pool → Direct + warn", async () => {
    proxyPools.push(relayPool());
    settings.providerStrategies = { opencode: { proxyPoolId: "relay-cf" } };
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds?.allRateLimited).toBeUndefined();
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.vercelRelayUrl).toBe("");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBeNull();
    const warned = logMock.warn.mock.calls.some(([, msg]) => /relay/i.test(String(msg)) && /relay-cf/.test(String(msg)));
    expect(warned).toBe(true);
  });

  it("(3b) opencode pinned to an HTTP proxy pool → still that pool", async () => {
    proxyPools.push(httpPool("http-a"));
    settings.providerStrategies = { opencode: { proxyPoolId: "http-a" } };
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds.id).toBe("noauth");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("http://http-a:8080");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("http-a");
  });

  it("(4) another noAuth provider + relay → relay unchanged (auto-rotate and pinned)", async () => {
    proxyPools.push(relayPool());
    const auto = await getProviderCredentials("mimo-free", null, "mimo-v2.5-free");
    expect(auto.id).toBe("noauth:relay-cf");
    expect(auto.providerSpecificData.vercelRelayUrl).toBe("https://cloudflare-relay.example.workers.dev");

    settings.providerStrategies = { "mimo-free": { proxyPoolId: "relay-cf" } };
    const pinned = await getProviderCredentials("mimo-free", null, "mimo-v2.5-free");
    expect(pinned.id).toBe("noauth");
    expect(pinned.providerSpecificData.vercelRelayUrl).toBe("https://cloudflare-relay.example.workers.dev");
    expect(pinned.providerSpecificData.connectionProxyPoolId).toBe("relay-cf");
  });

  it("(5) opencode + all http pools parked (plus a relay) → allRateLimited still works", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    proxyPools.push(
      relayPool(),
      httpPool("http-a", { unavailableUntil: future, lastError: "[429]: Rate limited" }),
      httpPool("http-b", { unavailableUntil: future, lastError: "[429]: Rate limited" }),
    );
    const creds = await getProviderCredentials("opencode", null, MODEL);
    expect(creds?.allRateLimited).toBe(true);
    expect(creds.lastErrorCode).toBe(429);
    expect(creds.retryAfter).toBe(new Date(future).toISOString());
  });
});
