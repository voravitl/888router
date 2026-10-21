import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression guard for the 2026-10-21 incident: an upstream HTTP 410
// (ModelDeprecated) for ONE retired model id poisoned the WHOLE shared
// opencode proxy-pool set, so every sibling `oc/*` model in the combo then
// failed with the same 410 body — and the combo reported the whole thing as
// "All models quota-limited" (429), which was a lie: nothing was quota-limited.
//
// Live evidence (docker logs 888route, 2026-10-21 12:46):
//
//   [AUTH] pool 811de521-… parked 30s [410] backoff=0
//   [AUTH] pool 602fdbbb-… parked 30s [410] backoff=0
//   [AUTH] opencode | all proxy pools parked [410], retry after reset after 26s
//   [CHAT] [opencode/beam-free] [410]: {"type":"error","error":{"type":"ModelDeprecated",…
//
// The relay is SHARED by every `oc/*` model, so parking it took down
// beam-free / glm-5.3-flash-free / longcat / minimax too.
//
// Cause: 410 matched NO rule in ERROR_RULES, so it fell through to the
// default transient rule (shouldFallback=true, 30s) → markAccountUnavailable
// parked the shared pool.
//
// Fix: 410 / ModelDeprecated is a PERMANENT MODEL error — the model identity
// is dead upstream, the relay is healthy. It must skip to the next model and
// must NOT park the shared pool.
//
// Like proxy-pool-quarantine.test.js, this file uses the REAL classifier and
// the REAL error config: the ordering/classification bug is invisible under a
// mocked checkFallbackError.

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
const { getProviderCredentials, markAccountUnavailable } =
  await import("../../src/sse/services/auth.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

// The upstream body opencode.ai returns for a retired model id, verbatim.
const MODEL_DEPRECATED_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "ModelDeprecated",
    message: "Model muse-spark-1.3-contributor-free has been deprecated.",
  },
  metadata: { model: "muse-spark-1.3-contributor-free" },
});

// The upstream body opencode.ai returns for a model that does not speak the
// requested protocol (400). Same bug class as the 410: the MODEL is unusable
// on this endpoint, the RELAY is healthy.
const MODEL_PROTOCOL_UNSUPPORTED_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "ModelProtocolUnsupported",
    message: "Model does not support this protocol.",
  },
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

describe("410 ModelDeprecated classification (real ERROR_RULES)", () => {
  it("is a permanent model error, not a transient failure", () => {
    const r = checkFallbackError(410, MODEL_DEPRECATED_BODY, 0);
    expect(r.modelError).toBe(true);
    expect(r.permanentModelError).toBe(true);
  });

  it("does not rotate accounts and does not park anything", () => {
    const r = checkFallbackError(410, MODEL_DEPRECATED_BODY, 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.parkMs).toBeUndefined();
  });

  it("classifies a bare 410 the same way (status rule, no text needed)", () => {
    const r = checkFallbackError(410, "Gone", 0);
    expect(r.modelError).toBe(true);
    expect(r.permanentModelError).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("does NOT regress 402 — a dead relay account must still rotate and park", () => {
    // The relay-deployment 402 (DEPLOYMENT_DISABLED) is the relay's fault, not
    // a model identity problem. It must keep parking the pool.
    const r = checkFallbackError(402, "Payment required\n\nDEPLOYMENT_DISABLED", 0);
    expect(r.shouldFallback).toBe(true);
    expect(r.modelError).toBeFalsy();
  });

  it("does NOT regress 429 — a real rate limit must still rotate and back off", () => {
    const r = checkFallbackError(429, "Rate limit exceeded", 2);
    expect(r.shouldFallback).toBe(true);
    expect(r.newBackoffLevel).toBe(3);
  });
});

describe("400 ModelProtocolUnsupported is a model error, not a relay failure", () => {
  // Same bug class as the 410, observed live on 2026-10-21 13:56:
  //
  //   [AUTH] pool 602fdbbb-… parked 30s [400] backoff=0
  //   [AUTH] opencode | all proxy pools parked [400], retry after reset after 28s
  //
  // A 400 for `oc/jev-1.13-free` parked the shared relay, and `oc/beam-free`
  // then answered 400 with a body about a protocol the caller never asked
  // about. The relay is fine; that one model does not speak chat/completions.

  it("is a permanent model error", () => {
    const r = checkFallbackError(400, MODEL_PROTOCOL_UNSUPPORTED_BODY, 0);
    expect(r.modelError).toBe(true);
    expect(r.permanentModelError).toBe(true);
  });

  it("does not rotate accounts and does not park the shared pool", () => {
    const r = checkFallbackError(400, MODEL_PROTOCOL_UNSUPPORTED_BODY, 0);
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
    expect(r.parkMs).toBeUndefined();
  });

  it("does not park the shared proxy pool on a 400 protocol error", async () => {
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });
    const r = await markAccountUnavailable("noauth:poolA", 400, MODEL_PROTOCOL_UNSUPPORTED_BODY, "opencode");
    expect(r.shouldFallback).toBe(false);
    expect(r.modelError).toBe(true);
    expect(poolWrites).toHaveLength(0);
  });
});

describe("a dead model must not take the shared relay down with it", () => {
  it("does NOT park the shared proxy pool on a 410", async () => {
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });

    const r = await markAccountUnavailable("noauth:poolA", 410, MODEL_DEPRECATED_BODY, "opencode");

    // The model is dead upstream; the relay is fine. Nothing may be parked,
    // and the caller must not rotate to another pool (there is nothing to
    // fix by switching relays — the model id is gone).
    expect(r.shouldFallback).toBe(false);
    expect(r.modelError).toBe(true);
    expect(poolWrites).toHaveLength(0);
  });

  it("keeps the shared pool selectable after a 410 (siblings stay alive)", async () => {
    // The incident's actual blast radius: beam-free / glm-5.3-flash-free /
    // longcat all ride the SAME pools as the dead model. If a 410 parks the
    // pool, every sibling dies with it. After the fix the pool must still be
    // handed out.
    resetPools({ id: "poolA", name: "A" }, { id: "poolB", name: "B" });
    await markAccountUnavailable("noauth:poolA", 410, MODEL_DEPRECATED_BODY, "opencode");
    await vi.waitFor(() => expect(poolWrites.length).toBe(0));

    const creds = await getProviderCredentials("opencode", null, "beam-free");
    expect(creds.id).toBe("noauth:poolA");
    expect(proxyPools.find((p) => p.id === "poolA").testStatus).toBeUndefined();
  });

  it("still parks the pool on a 402 (relay deployment disabled)", async () => {
    resetPools({ id: "poolA", name: "A" });
    const r = await markAccountUnavailable("noauth:poolA", 402, "Payment required\n\nDEPLOYMENT_DISABLED", "opencode");
    expect(r.shouldFallback).toBe(true);
    await vi.waitFor(() => expect(poolWrites.length).toBeGreaterThan(0));
    expect(poolWrites.at(-1).testStatus).toBe("unavailable");
  });
});
