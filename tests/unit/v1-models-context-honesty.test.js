import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Guards two regressions in GET /v1/models:
//
//  1. Honest context windows. getCapabilitiesForModel() merges
//     DEFAULT_CAPABILITIES (contextWindow 200000) unconditionally, so a model
//     absent from the PROVIDER / MODEL / PATTERN tables used to be published
//     with context_length: 200000 as if that were fact. Both directions are
//     harmful: a real 32k model advertised as 200k fails at runtime with
//     context_overflow, and a real 1M model advertised as 200k throws away
//     80% of the usable window. The field must be omitted when unknown.
//
//  2. Bounded latency. The provider loop used to await each live-catalog fetch
//     sequentially, making response time the SUM of every upstream round-trip
//     across ~20 connections. It must be the MAX, and each fetch must have its
//     own budget so a dead upstream cannot set even that.

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  resolveKiroModels: vi.fn(async () => null),
  resolveQoderModels: vi.fn(async () => null),
  resolveKimchiModels: vi.fn(async () => null),
  resolveCopilotModels: vi.fn(async () => null),
  resolveClinepassModels: vi.fn(async () => null),
  listAvailableModels: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: mocks.getAllModelDynamicCapabilities,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, registerDynamicCapabilitiesScoped: vi.fn() };
});

vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: mocks.resolveKiroModels }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: mocks.resolveQoderModels }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: mocks.resolveKimchiModels }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: mocks.resolveCopilotModels }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: mocks.resolveClinepassModels }));
vi.mock("@/lib/oauth/services/ollama", () => ({
  OllamaService: class {
    async listAvailableModels() {
      return mocks.listAvailableModels();
    }
  },
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  refreshGoogleToken: vi.fn(async () => ({ accessToken: "x" })),
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");

// An explicit enabledModels list pins the provider to those ids and SKIPS the
// live resolver entirely (see `liveResolver && !hasExplicitEnabledModels`), so it
// is the right shape for the capability assertions and the wrong shape for the
// latency ones.
const conn = (provider, extra = {}) => ({
  id: `conn-${provider}`,
  provider,
  isActive: true,
  apiKey: "sk-test",
  providerSpecificData: { enabledModels: ["definitely-not-a-real-model-id-xyz"], ...extra },
});

// No enabledModels -> the live-catalog resolver for this provider actually runs.
const connLive = (provider, extra = {}) => ({
  id: `conn-${provider}`,
  provider,
  isActive: true,
  apiKey: "sk-test",
  providerSpecificData: { ...extra },
});

const idsWithPrefix = (list, prefix) =>
  [...list.keys()].filter((id) => id.startsWith(`${prefix}/`));

async function models() {
  const res = await GET(new Request("http://localhost/v1/models"));
  expect(res.status).toBe(200);
  const body = await res.json();
  return new Map(body.data.map((m) => [m.id, m]));
}

describe("/v1/models — context window honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
  });

  it("omits context_length for a model no source knows (no fabricated 200k floor)", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("nara")]);
    const list = await models();

    const entry = list.get("nara/definitely-not-a-real-model-id-xyz");
    expect(entry).toBeDefined();
    expect(entry.context_length).toBeUndefined();
    expect(entry.context_window).toBeUndefined();
    expect(entry.contextWindow).toBeUndefined();
    // The capabilities object must not contradict the absent top-level fields
    // by still carrying the DEFAULT_CAPABILITIES floor.
    expect(entry.capabilities?.contextWindow).toBeUndefined();
    expect(entry.capabilities?.maxOutput).toBeUndefined();
  });

  it("still reports a real context window for a catalogue-known model", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("nara", { enabledModels: ["gpt-4o"] })]);
    const list = await models();

    const entry = list.get("nara/gpt-4o");
    expect(entry).toBeDefined();
    // 128000 is the catalogue value for gpt-4o — the same number
    // resolveComboContextWindow returns for it, so the two paths agree.
    expect(entry.context_length).toBe(128000);
    expect(entry.context_window).toBe(entry.context_length);
    expect(entry.contextWindow).toBe(entry.context_length);
    expect(entry.max_tokens).toBeGreaterThan(0);
  });

  it("prefers a synced (DB) context window over the catalogue", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("nara", { enabledModels: ["gpt-4o"] })]);
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(
      new Map([["nara:gpt-4o", { contextWindow: 400000, maxOutput: 32000 }]]),
    );
    const list = await models();

    const entry = list.get("nara/gpt-4o");
    expect(entry.context_length).toBe(400000);
    expect(entry.max_tokens).toBe(32000);
  });
});

describe("/v1/models — latency", () => {
  const realEnv = process.env.MODELS_LIVE_FETCH_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
    // Default every live resolver to "no live catalog" so each test opts in to
    // exactly the latency it wants to measure.
    mocks.resolveKiroModels.mockResolvedValue(null);
    mocks.resolveQoderModels.mockResolvedValue(null);
    mocks.resolveKimchiModels.mockResolvedValue(null);
    mocks.resolveCopilotModels.mockResolvedValue(null);
    mocks.resolveClinepassModels.mockResolvedValue(null);
  });

  afterEach(() => {
    if (realEnv === undefined) delete process.env.MODELS_LIVE_FETCH_TIMEOUT_MS;
    else process.env.MODELS_LIVE_FETCH_TIMEOUT_MS = realEnv;
    vi.resetModules();
  });

  it("resolves providers concurrently, so wall time is the slowest upstream not the sum", async () => {
    // Count how many live resolvers are in flight at the same time instead of
    // asserting on wall-clock. A timing threshold would be flaky: the route also
    // does ~1s of synchronous per-model catalogue work that does not scale with
    // these sleeps and swamps a 120ms-per-provider signal. Overlap is the
    // property we actually care about, and it is deterministic.
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((r) => setTimeout(() => { inFlight -= 1; r(null); }, 120));
    };
    for (const resolver of [
      mocks.resolveKiroModels, mocks.resolveQoderModels,
      mocks.resolveCopilotModels, mocks.resolveClinepassModels,
    ]) {
      resolver.mockImplementation(() => gate());
    }

    mocks.getProviderConnections.mockResolvedValue([
      connLive("kiro"), connLive("qoder"), connLive("github"), connLive("clinepass"),
    ]);

    const list = await models();

    // All four resolvers ran, and all four were in flight together. The old
    // sequential `for..of` + await loop peaked at 1.
    for (const resolver of [
      mocks.resolveKiroModels, mocks.resolveQoderModels,
      mocks.resolveCopilotModels, mocks.resolveClinepassModels,
    ]) {
      expect(resolver).toHaveBeenCalled();
    }
    expect(maxInFlight).toBe(4);
    // Concurrency must not drop provider coverage. Client-facing ids use the
    // provider alias (kiro -> kr, qoder -> qd, github -> gh), not the registry id.
    for (const alias of ["kr", "qd", "gh", "clinepass"]) {
      expect(idsWithPrefix(list, alias).length).toBeGreaterThan(0);
    }
  }, 60000);

  it("falls back to the static list when a live resolver exceeds its budget", async () => {
    // The budget is read at module load, so set it before importing a fresh copy.
    process.env.MODELS_LIVE_FETCH_TIMEOUT_MS = "80";
    vi.resetModules();
    const fresh = await import("../../src/app/api/v1/models/route.js");

    mocks.resolveKiroModels.mockImplementation(() => new Promise(() => {})); // never settles
    mocks.getProviderConnections.mockResolvedValue([connLive("kiro")]);

    const res = await fresh.GET(new Request("http://localhost/v1/models"));
    // No wall-clock assertion on purpose. Without a budget the never-settling
    // resolver blocks the response forever, so the per-test timeout below is
    // the detector: it fires on the old code and passes on the fixed code. An
    // explicit `elapsed < N` bound would be flaky instead — the route does ~1s
    // of synchronous catalogue work whose cost swings with machine load, and
    // that is not what this test is about.
    expect(mocks.resolveKiroModels).toHaveBeenCalled();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Static catalogue served for the stalled provider, not an empty list.
    expect(body.data.some((m) => m.id.startsWith("kr/"))).toBe(true);
  }, 60000);

  it("one slow resolver does not suppress the other providers' models", async () => {
    process.env.MODELS_LIVE_FETCH_TIMEOUT_MS = "80";
    vi.resetModules();
    const fresh = await import("../../src/app/api/v1/models/route.js");

    mocks.resolveKiroModels.mockImplementation(() => new Promise(() => {}));
    mocks.resolveCopilotModels.mockResolvedValue({ models: [{ id: "copilot-live-model" }] });
    mocks.getProviderConnections.mockResolvedValue([connLive("kiro"), connLive("github")]);

    const body = await (await fresh.GET(new Request("http://localhost/v1/models"))).json();
    const ids = body.data.map((m) => m.id);
    // The healthy provider's LIVE model still lands even though its peer hangs.
    expect(ids).toContain("gh/copilot-live-model");
    expect(ids.some((id) => id.startsWith("kr/"))).toBe(true);
  }, 60000);
});
