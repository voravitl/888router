import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSyncedModelsMap: vi.fn(async () => ({})),
  getProviderConnections: vi.fn(async () => []),
  providerModelsGet: vi.fn(),
  execSync: vi.fn(),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  fetch: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({
      status: init?.status || 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/db", () => ({
  getSyncedModelsMap: (...a) => mocks.getSyncedModelsMap(...a),
  getAllModelDynamicCapabilities: (...a) => mocks.getAllModelDynamicCapabilities(...a),
  stampSyncedModels: vi.fn(async () => ({})),
  saveModelDynamicCapabilities: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...a) => mocks.getProviderConnections(...a),
  getCombos: (...a) => mocks.getCombos(...a),
  getCustomModels: (...a) => mocks.getCustomModels(...a),
  getModelAliases: (...a) => mocks.getModelAliases(...a),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: (...a) => mocks.getDisabledModels(...a),
}));

vi.mock("open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, registerDynamicCapabilitiesScoped: vi.fn() };
});

vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));
vi.mock("@/lib/oauth/services/ollama", () => ({
  OllamaService: class {
    async listAvailableModels() { return []; }
  },
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  refreshGoogleToken: vi.fn(async () => null),
}));

vi.mock("@/app/api/providers/[id]/models/route.js", () => ({
  GET: (...a) => mocks.providerModelsGet(...a),
}));

vi.mock("child_process", () => ({
  execSync: (...a) => mocks.execSync(...a),
}));

describe("GET & POST /api/models/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    delete globalThis.__modelSyncInFlight;
    mocks.getSyncedModelsMap.mockResolvedValue({});
    mocks.getProviderConnections.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.__modelSyncInFlight;
  });

  it("GET computes activeCount, staleCount, lastSyncedAt, byConnection, and byProvider (including public:<provider> and colon model ids)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", provider: "openai", isActive: true },
      { id: "conn-2", provider: "openai", isActive: false },
    ]);
    mocks.getSyncedModelsMap.mockResolvedValue({
      "conn-1:gpt-4o": { status: "active", lastSyncedAt: "2026-11-10T10:00:00.000Z" },
      "conn-1:gpt-old": { status: "stale", lastSyncedAt: "2026-11-01T10:00:00.000Z" },
      "conn-2:gpt-4.5": { status: "active", lastSyncedAt: "2026-11-12T08:00:00.000Z" },
      "public:opencode:deepseek-v4:free": { status: "active", lastSyncedAt: "2026-11-15T12:00:00.000Z" },
      "public:opencode:old:free": { status: "stale", lastSyncedAt: "2026-11-05T12:00:00.000Z" },
    });

    const { GET } = await import("../../src/app/api/models/sync/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({
      totalSyncedEntries: 5,
      activeCount: 3,
      staleCount: 2,
      lastSyncedAt: "2026-11-15T12:00:00.000Z",
      byConnection: {
        "conn-1": { provider: "openai", activeCount: 1, staleCount: 1, lastSyncedAt: "2026-11-10T10:00:00.000Z" },
        "conn-2": { provider: "openai", activeCount: 1, staleCount: 0, lastSyncedAt: "2026-11-12T08:00:00.000Z" },
        "public:opencode": { provider: "opencode", activeCount: 1, staleCount: 1, lastSyncedAt: "2026-11-15T12:00:00.000Z" },
      },
      byProvider: {
        openai: { activeCount: 2, staleCount: 1, lastSyncedAt: "2026-11-12T08:00:00.000Z" },
        opencode: { activeCount: 1, staleCount: 1, lastSyncedAt: "2026-11-15T12:00:00.000Z" },
      },
    });
  });

  it("POST selects eligible active connections, skips inactive/unsupported/missing-baseUrl compatible nodes, and returns summary", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c-openai", provider: "openai", isActive: true },
      { id: "c-inactive", provider: "anthropic", isActive: false },
      { id: "c-web", provider: "chatgpt-web", isActive: true },
      { id: "c-compat-no-url", provider: "openai-compatible-custom1", isActive: true, providerSpecificData: {} },
      { id: "c-compat-ok", provider: "anthropic-compatible-custom2", isActive: true, providerSpecificData: { baseUrl: "https://example.com/v1" } },
    ]);

    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      if (id === "c-openai") {
        return { status: 200, json: async () => ({ provider: "openai", connectionId: id, models: [{ id: "gpt-4o" }, { id: "gpt-5" }] }) };
      }
      if (id === "c-compat-ok") {
        return { status: 200, json: async () => ({ provider: "anthropic-compatible-custom2", connectionId: id, models: [{ id: "claude-x" }], warning: "partial" }) };
      }
      throw new Error(`Unexpected sync target: ${id}`);
    });

    mocks.getSyncedModelsMap.mockResolvedValue({
      "c-openai:gpt-4o": { status: "active", lastSyncedAt: "2026-11-18T00:00:00.000Z" },
      "c-openai:gpt-5": { status: "active", lastSyncedAt: "2026-11-18T00:00:00.000Z" },
      "c-compat-ok:claude-x": { status: "active", lastSyncedAt: "2026-11-18T00:00:00.000Z" },
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");
    const res = await POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(2);
    expect(body).toEqual({
      ok: true,
      syncedProviders: 2,
      syncedConnections: 2,
      totalModels: 3,
      activeCount: 3,
      staleCount: 0,
      lastSyncedAt: "2026-11-18T00:00:00.000Z",
      results: [
        { connectionId: "c-openai", provider: "openai", ok: true, modelCount: 2 },
        { connectionId: "c-compat-ok", provider: "anthropic-compatible-custom2", ok: true, modelCount: 1, warning: "partial" },
      ],
    });
  });

  it("POST includes public provider directly when providerId is public and has no active connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c-oc-off", provider: "opencode", isActive: false },
    ]);
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      return {
        status: 200,
        json: async () => ({ provider: id, connectionId: `public:${id}`, models: [{ id: "big-pickle" }] }),
      };
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");
    const res = await POST(
      new Request("http://localhost/api/models/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "opencode" }),
      })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(1);
    const [, ctx] = mocks.providerModelsGet.mock.calls[0];
    expect(await ctx.params).toEqual({ id: "opencode" });
    expect(body.syncedProviders).toBe(1);
    expect(body.syncedConnections).toBe(1);
    expect(body.totalModels).toBe(1);
    expect(body.results).toEqual([
      { connectionId: "public:opencode", provider: "opencode", ok: true, modelCount: 1 },
    ]);
  });

  it("POST enforces bounded concurrency MAX_CONCURRENCY = 4", async () => {
    const conns = Array.from({ length: 10 }, (_, i) => ({
      id: `c-${i}`,
      provider: "openai",
      isActive: true,
    }));
    mocks.getProviderConnections.mockResolvedValue(conns);

    let inFlight = 0;
    let maxInFlight = 0;
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return { status: 200, json: async () => ({ provider: "openai", connectionId: id, models: [{ id: "m1" }] }) };
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");
    const res = await POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    const body = await res.json();

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBe(4);
    expect(body.syncedConnections).toBe(10);
    expect(body.syncedProviders).toBe(1);
    expect(body.totalModels).toBe(10);
  });

  it("POST enforces per-target 10000ms timeout without aborting healthy peers", async () => {
    vi.useFakeTimers();
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c-hang", provider: "openai", isActive: true },
      { id: "c-fast", provider: "anthropic", isActive: true },
    ]);
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      if (id === "c-hang") return new Promise(() => {});
      return { status: 200, json: async () => ({ provider: "anthropic", connectionId: id, models: [{ id: "claude-sonnet-4-6" }] }) };
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");
    const pending = POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    await vi.advanceTimersByTimeAsync(10005);
    const res = await pending;
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.syncedProviders).toBe(1);
    expect(body.syncedConnections).toBe(1);
    expect(body.totalModels).toBe(1);
    expect(body.results[0]).toMatchObject({
      connectionId: "c-hang",
      provider: "openai",
      ok: false,
      modelCount: 0,
    });
    expect(body.results[0].error).toMatch(/timed out/i);
    expect(body.results[1]).toEqual({
      connectionId: "c-fast",
      provider: "anthropic",
      ok: true,
      modelCount: 1,
    });
  });

  it("POST deduplicates concurrent requests sharing the same scope via globalThis.__modelSyncInFlight", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c-1", provider: "openai", isActive: true },
    ]);
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });
    mocks.providerModelsGet.mockImplementation(async () => {
      await gate;
      return { status: 200, json: async () => ({ provider: "openai", connectionId: "c-1", models: [{ id: "gpt-4o" }] }) };
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");
    const p1 = POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    const p2 = POST(new Request("http://localhost/api/models/sync", { method: "POST" }));

    // Let async body parsing & target setup settle before releasing upstream gate
    await new Promise((r) => setTimeout(r, 10));
    expect(globalThis.__modelSyncInFlight).toBeDefined();
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(1);

    resolveGate();
    const [r1, r2] = await Promise.all([p1, p2]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);

    expect(b1).toEqual(b2);
    expect(b1.totalModels).toBe(1);
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(1);

    // Subsequent sequential call runs cleanly once in-flight guard clears
    const r3 = await POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    expect((await r3.json()).totalModels).toBe(1);
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(2);
  });

  it("GET returns zeroed summary when syncedModelsMap is empty", async () => {
    mocks.getSyncedModelsMap.mockResolvedValue({});
    const { GET } = await import("../../src/app/api/models/sync/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalSyncedEntries: 0,
      activeCount: 0,
      staleCount: 0,
      lastSyncedAt: null,
      byConnection: {},
      byProvider: {},
    });
  });

  it("POST filters by connectionId and records per-target HTTP errors without failing the batch", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c-ok", provider: "openai", isActive: true },
      { id: "c-err", provider: "anthropic", isActive: true },
    ]);
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      if (id === "c-err") {
        return { status: 401, json: async () => ({ error: "Invalid API key" }) };
      }
      return { status: 200, json: async () => ({ provider: "openai", connectionId: id, models: [{ id: "gpt-4o" }] }) };
    });

    const { POST } = await import("../../src/app/api/models/sync/route.js");

    // 1. Scoped to single connectionId
    const resSingle = await POST(
      new Request("http://localhost/api/models/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: "c-ok" }),
      })
    );
    const bodySingle = await resSingle.json();
    expect(bodySingle.syncedConnections).toBe(1);
    expect(bodySingle.results).toEqual([
      { connectionId: "c-ok", provider: "openai", ok: true, modelCount: 1 },
    ]);

    // 2. Full batch records c-err error cleanly alongside c-ok
    const resAll = await POST(new Request("http://localhost/api/models/sync", { method: "POST" }));
    const bodyAll = await resAll.json();
    expect(bodyAll.ok).toBe(true);
    expect(bodyAll.syncedProviders).toBe(1);
    expect(bodyAll.syncedConnections).toBe(1);
    expect(bodyAll.totalModels).toBe(1);
    expect(bodyAll.results).toEqual([
      { connectionId: "c-ok", provider: "openai", ok: true, modelCount: 1 },
      { connectionId: "c-err", provider: "anthropic", ok: false, modelCount: 0, error: "Invalid API key" },
    ]);
  });
});

describe("__openai-generic__ normalization in /v1/models", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mocks.fetch;
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes vision, pdf, tools, reasoning, contextWindow, maxOutput, and releasedAt for generic openai providers", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-vercel",
        provider: "vercel-ai-gateway",
        apiKey: "vg-secret",
        isActive: true,
        providerSpecificData: {},
      },
    ]);
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "acme/vision-pro",
            name: "Acme Vision Pro",
            created: 1767321600,
            modalities: { input: ["text", "image/png", "application/pdf"] },
            limit: { context: 131072, output: 16384 },
            capabilities: { reasoning: { supported: true }, tools: { supported: true } },
          },
          {
            id: "acme/text-only",
            supportsImages: false,
            context_length: 65536,
            max_tokens: 4096,
          },
        ],
      }),
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const visionModel = body.data.find((m) => m.id === "vercel/acme/vision-pro");
    expect(visionModel).toBeDefined();
    expect(visionModel.context_length).toBe(131072);
    expect(visionModel.contextWindow).toBe(131072);
    expect(visionModel.max_tokens).toBe(16384);
    expect(visionModel.capabilities).toMatchObject({
      vision: true,
      pdf: true,
      reasoning: true,
      tools: true,
      contextWindow: 131072,
      maxOutput: 16384,
    });
    expect(String(visionModel.capabilities.releasedAt)).toMatch(/^2026-01-02T/);

    const textOnly = body.data.find((m) => m.id === "vercel/acme/text-only");
    expect(textOnly).toBeDefined();
    expect(textOnly.context_length).toBe(65536);
    expect(textOnly.max_tokens).toBe(4096);
    expect(textOnly.capabilities.vision).toBe(false);
  });
});

describe("FILTERS.openai capability normalization", () => {
  it("preserves vision, reasoning, tools, pdf, audioInput, videoInput, releasedAt, and contextLength", async () => {
    const { FILTERS } = await import("../../src/app/api/providers/suggested-models/filters.js");
    const out = FILTERS.openai(
      [
        {
          id: "omni-model",
          display_name: "Omni Model",
          created: 1767321600,
          modalities: { input: ["text", "image", "application/pdf", "audio/*", "video/*"] },
          limit: { context: 256000, output: 32000 },
          capabilities: { reasoning: { supported: true }, tools: { supported: true } },
        },
      ],
      "openai"
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "omni-model",
      name: "Omni Model",
      contextLength: 256000,
      vision: true,
      reasoning: true,
      tools: true,
      pdf: true,
      audioInput: true,
      videoInput: true,
    });
    expect(String(out[0].releasedAt)).toMatch(/^2026-01-02T/);
  });
});

describe("POST /api/sync-opencode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers live sync for opencode and opencode-go even when execSync fails on read-only fs", async () => {
    mocks.execSync.mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      return {
        status: 200,
        json: async () => ({
          provider: id,
          connectionId: `public:${id}`,
          models: id === "opencode" ? [{ id: "big-pickle" }, { id: "grok-free" }] : [{ id: "glm-5.2" }],
        }),
      };
    });

    const { POST } = await import("../../src/app/api/sync-opencode/route.js");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.scriptWarning).toContain("EROFS");
    expect(body.totalModels).toBe(3);
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(2);
    const calledIds = await Promise.all(
      mocks.providerModelsGet.mock.calls.map(async ([, ctx]) => (await ctx.params).id)
    );
    expect(calledIds.sort()).toEqual(["opencode", "opencode-go"]);
  });

  it("still triggers live SQLite provider sync when execSync succeeds", async () => {
    mocks.execSync.mockReturnValue("Found 5 models");
    mocks.providerModelsGet.mockImplementation(async (_req, { params }) => {
      const { id } = await params;
      return {
        status: 200,
        json: async () => ({ provider: id, connectionId: `public:${id}`, models: [{ id: "m1" }] }),
      };
    });

    const { POST } = await import("../../src/app/api/sync-opencode/route.js");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.output).toBe("Found 5 models");
    expect(body.scriptWarning).toBeUndefined();
    expect(body.totalModels).toBe(2);
    expect(mocks.providerModelsGet).toHaveBeenCalledTimes(2);
  });
});
