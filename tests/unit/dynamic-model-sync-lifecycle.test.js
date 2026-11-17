import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared contract for the model-sync redesign:
//   upstream metadata → normalized capabilities → persisted "active" rows →
//   "stale" ghosts on a later successful sync → clean lookups on every surface.
const mocks = vi.hoisted(() => ({
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  getSyncedModelsMap: vi.fn(async () => ({})),
  getModelDynamicCapabilities: vi.fn(async () => null),
  stampSyncedModels: vi.fn(async () => ({})),
  saveModelDynamicCapabilities: vi.fn(async () => {}),
  getModelAliases: vi.fn(async () => ({})),
  setModelAlias: vi.fn(async () => {}),
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getComboByName: vi.fn(async () => null),
  getDisabledModels: vi.fn(async () => ({})),
  refreshGoogleToken: vi.fn(async () => null),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: (...a) => mocks.getAllModelDynamicCapabilities(...a),
  getSyncedModelsMap: (...a) => mocks.getSyncedModelsMap(...a),
  getModelDynamicCapabilities: (...a) => mocks.getModelDynamicCapabilities(...a),
  stampSyncedModels: (...a) => mocks.stampSyncedModels(...a),
  saveModelDynamicCapabilities: (...a) => mocks.saveModelDynamicCapabilities(...a),
  initDb: vi.fn(async () => {}),
}));
vi.mock("@/models", () => ({
  getModelAliases: (...a) => mocks.getModelAliases(...a),
  setModelAlias: (...a) => mocks.setModelAlias(...a),
  getProviderConnectionById: vi.fn(async () => null),
  getProviderConnections: (...a) => mocks.getProviderConnections(...a),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...a) => mocks.getProviderConnections(...a),
  getCombos: (...a) => mocks.getCombos(...a),
  getCustomModels: (...a) => mocks.getCustomModels(...a),
  getModelAliases: (...a) => mocks.getModelAliases(...a),
  getComboByName: (...a) => mocks.getComboByName(...a),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: (...a) => mocks.getDisabledModels(...a),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: (...a) => mocks.refreshGoogleToken(...a),
  updateProviderCredentials: (...a) => mocks.updateProviderCredentials(...a),
}));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) },
}));

const SYNCED_MAP = new Map([
  ["opencode-go:hy4-flash-free", {
    contextWindow: 256000,
    maxOutput: 64000,
    vision: true,
    pdf: true,
    audioInput: true,
    videoInput: true,
    tools: true,
    reasoning: true,
    search: false,
    releasedAt: "2026-01-02T00:00:00.000Z",
  }],
]);

describe("normalizeUpstreamModel", () => {
  it("normalizes the OpenCode Go hy4-flash-free rich upstream shape", async () => {
    const { normalizeUpstreamModel, collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const raw = {
      id: "hy4-flash-free",
      object: "model",
      created: 1767321600, // epoch seconds -> ISO
      modalities: {
        input: ["text", "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "audio/*", "video/*"],
        output: ["text"],
      },
      limit: { context: 256000, output: 64000 },
      capabilities: { reasoning: { supported: true }, tools: { supported: true } },
      search: true,
    };

    const model = normalizeUpstreamModel("opencode-go", raw);
    expect(model.id).toBe("hy4-flash-free");
    expect(model.vision).toBe(true);
    expect(model.pdf).toBe(true);
    expect(model.audioInput).toBe(true);
    expect(model.videoInput).toBe(true);
    expect(model.contextWindow).toBe(256000);
    expect(model.context_length).toBe(256000);
    expect(model.maxOutput).toBe(64000);
    expect(model.reasoning).toBe(true);
    expect(model.tools).toBe(true);
    expect(model.search).toBe(true);
    expect(String(model.releasedAt)).toMatch(/^2026-01-02T/);
    // Input object is never mutated.
    expect(raw.vision).toBeUndefined();
    expect(raw.contextWindow).toBeUndefined();

    expect(collectNormalizedCapabilities(model)).toMatchObject({
      contextWindow: 256000,
      maxOutput: 64000,
      vision: true,
      pdf: true,
      reasoning: true,
    });
  });

  it("handles the short ['text','image'] modality form and explicit booleans", async () => {
    const { normalizeUpstreamModel } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const short = normalizeUpstreamModel("opencode", {
      id: "short",
      input_modalities: ["text", "image"],
      context_length: 200000,
      max_tokens: 32000,
    });
    expect(short.vision).toBe(true);
    expect(short.contextWindow).toBe(200000);
    expect(short.maxOutput).toBe(32000);

    // An explicit upstream boolean wins over a stale modality list.
    const explicit = normalizeUpstreamModel("opencode", {
      id: "explicit",
      modalities: { input: ["text", "image"] },
      supportsImages: false,
    });
    expect(explicit.vision).toBe(false);
  });
});

describe("reconcileSyncedModelsForConnection", () => {
  let tempDir;
  let originalDataDir;
  let repo;

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sync-lifecycle-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();
    repo = await import("@/lib/db/repos/syncedModelsRepo.js");
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("transitions absent ids to stale, keeps ghosts, and clears on re-stamp", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-02-01T00:00:00.000Z";
    await repo.stampSyncedModels([
      { connectionId: "conn-ocg", modelId: "hy4-flash-free" },
      { connectionId: "conn-ocg", modelId: "retired-model" },
    ], { now: t1 });

    let map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:hy4-flash-free"].status).toBe("active");
    expect(map["conn-ocg:retired-model"].status).toBe("active");
    expect(map["conn-ocg:hy4-flash-free"].lastSyncedAt).toBe(t1);

    const changed = await repo.reconcileSyncedModelsForConnection(
      "conn-ocg", ["hy4-flash-free"], { now: t2 }
    );
    expect(Object.keys(changed)).toEqual(["conn-ocg:retired-model"]);

    map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:retired-model"].status).toBe("stale");
    expect(map["conn-ocg:retired-model"].missingSince).toBe(t2);
    expect(map["conn-ocg:retired-model"].firstSeenAt).toBe(t1);
    expect(map["conn-ocg:hy4-flash-free"].status).toBe("active");

    // A later sync must not refresh a ghost's missingSince.
    await repo.reconcileSyncedModelsForConnection(
      "conn-ocg", ["hy4-flash-free"], { now: "2026-03-01T00:00:00.000Z" }
    );
    map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:retired-model"].missingSince).toBe(t2);

    // Seeing the model again clears the ghost marker but keeps firstSeenAt.
    const restamped = await repo.stampSyncedModels(
      [{ connectionId: "conn-ocg", modelId: "retired-model" }], { now: t2 }
    );
    expect(restamped["conn-ocg:retired-model"].status).toBe("active");
    expect(restamped["conn-ocg:retired-model"].missingSince).toBeUndefined();
    expect(restamped["conn-ocg:retired-model"].firstSeenAt).toBe(t1);
  });

  it("never marks anything stale on an empty or failed upstream response", async () => {
    await repo.stampSyncedModels([{ connectionId: "conn-empty", modelId: "m1" }]);
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", [])).toEqual({});
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", null)).toEqual({});
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", "m1")).toEqual({});
    const map = await repo.getSyncedModelsMap();
    expect(map["conn-empty:m1"].status).toBe("active");
    expect(map["conn-empty:m1"].missingSince).toBeUndefined();
  });

  it("keeps vision-only capability rows but rejects malformed contextWindow", async () => {
    await repo.saveModelDynamicCapabilities("opencode-go", "vision-only", { vision: true });
    await repo.saveModelDynamicCapabilities("opencode-go", "bad-cw", { contextWindow: 1, vision: true });
    const all = await repo.getAllModelDynamicCapabilities();
    expect(all.get("opencode-go:vision-only").vision).toBe(true);
    expect(all.has("opencode-go:bad-cw")).toBe(false);
  });
});

describe("synced capabilities on HTTP surfaces", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getAllModelDynamicCapabilities.mockReset().mockResolvedValue(SYNCED_MAP);
    mocks.getSyncedModelsMap.mockReset().mockResolvedValue({
      "conn-ocg:hy4-flash-free": { status: "active", firstSeenAt: "t1", lastSyncedAt: "t2" },
    });
    mocks.getModelDynamicCapabilities.mockReset().mockImplementation(async (providerId, modelId) => {
      return SYNCED_MAP.get(`${providerId}:${String(modelId).split("/").pop()}`) || null;
    });
    mocks.getModelAliases.mockReset().mockResolvedValue({});
    mocks.getDisabledModels.mockReset().mockResolvedValue({});
    mocks.getProviderConnections.mockReset().mockResolvedValue([]);
    mocks.getCombos.mockReset().mockResolvedValue([]);
    mocks.getCustomModels.mockReset().mockResolvedValue([]);
  });

  it("GET /api/models exposes dynamicCapsByKey under both provider id and alias", async () => {
    const { GET } = await import("../../src/app/api/models/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dynamicCapsByKey["ocg/hy4-flash-free"].vision).toBe(true);
    expect(data.dynamicCapsByKey["opencode-go/hy4-flash-free"].maxOutput).toBe(64000);
    expect(data.dynamicCapsByKey["ocg/hy4-flash-free"].pdf).toBe(true);
    expect(data.models.some((m) => m.fullModel === "opencode-go/hy4-flash-free")).toBe(true);
  });

  it("GET /api/v1/models/info?id=ocg/hy4-flash-free resolves from synced caps", async () => {
    const { GET } = await import("../../src/app/api/v1/models/info/route.js");
    const res = await GET(new Request("http://localhost/v1/models/info?id=ocg/hy4-flash-free"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vision).toBe(true);
    expect(body.capabilities.vision).toBe(true);
    expect(body.contextWindow).toBe(256000);
    expect(body.max_tokens).toBe(64000);
    expect(body.status).toBe("active");
    expect(body.source).toBe("synced");
  });

  it("GET /api/v1/models/info still 404s for an unknown synced-less model", async () => {
    mocks.getModelDynamicCapabilities.mockResolvedValue(null);
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
    const { GET } = await import("../../src/app/api/v1/models/info/route.js");
    const res = await GET(new Request("http://localhost/v1/models/info?id=ocg/no-such-model"));
    expect(res.status).toBe(404);
  });
});

describe("buildModelsResponse reconciliation guard", () => {
  let reconcile;

  beforeEach(() => {
    reconcile = vi.fn(async () => ({}));
    vi.doMock("@/lib/db/repos/syncedModelsRepo.js", () => ({ reconcileSyncedModelsForConnection: reconcile }));
    vi.resetModules();
    mocks.stampSyncedModels.mockReset().mockResolvedValue({});
    mocks.getSyncedModelsMap.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    vi.doUnmock("@/lib/db/repos/syncedModelsRepo.js");
  });

  it("reconciles a live non-empty model list", async () => {
    const { buildModelsResponse } = await import("../../src/app/api/providers/[id]/models/route.js");
    await buildModelsResponse({
      provider: "opencode-go",
      connectionId: "conn-live",
      models: [{ id: "hy4-flash-free" }],
    });
    expect(reconcile).toHaveBeenCalledWith("conn-live", ["hy4-flash-free"]);
  });

  it("does not reconcile a static fallback list even when non-empty", async () => {
    const { buildModelsResponse } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await buildModelsResponse({
      provider: "xai",
      connectionId: "conn-stale-fallback",
      models: [{ id: "grok-4" }],
      reconcile: false,
    });
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
