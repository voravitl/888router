import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  stampSyncedModels: vi.fn(async () => ({})),
  getSyncedModelsMap: vi.fn(async () => ({})),
  saveModelDynamicCapabilities: vi.fn(async () => ({})),
  fetch: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  getSyncedModelsMap: mocks.getSyncedModelsMap,
  stampSyncedModels: mocks.stampSyncedModels,
  saveModelDynamicCapabilities: mocks.saveModelDynamicCapabilities,
}));

vi.stubGlobal("fetch", mocks.fetch);

describe("OpenAI Provider Model Sync (GPT-6 Support)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges static GPT-6 models into synced models list when upstream returns standard models", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-openai-1",
      provider: "openai",
      apiKey: "sk-openai-test-key",
      isActive: true,
    });

    // Upstream OpenAI GET /v1/models returns standard models (gpt-4o, etc.) but no gpt-6 yet
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        object: "list",
        data: [
          { id: "gpt-4o", object: "model", created: 1715368132, owned_by: "system" },
          { id: "gpt-4o-mini", object: "model", created: 1721172741, owned_by: "system" },
        ],
      }),
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn-openai-1/models"), {
      params: Promise.resolve({ id: "conn-openai-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    const modelIds = body.models.map((m) => m.id);
    // Upstream models present
    expect(modelIds).toContain("gpt-4o");
    expect(modelIds).toContain("gpt-4o-mini");

    // Static registry GPT-6 models merged (official upstream slug)
    expect(modelIds).toContain("gpt-6-astra");

    // Dynamic caps saved for GPT-6
    expect(mocks.saveModelDynamicCapabilities).toHaveBeenCalledWith(
      "openai",
      "gpt-6-astra",
      expect.objectContaining({ contextWindow: 1050000, vision: true, reasoning: true })
    );

    // Stamped into synced models kv
    expect(mocks.stampSyncedModels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: "conn-openai-1", modelId: "gpt-6-astra" }),
      ])
    );
  });

  it("merges GPT-6.1 Sol and the 5.6/5.5 line, not just gpt-6-* ids", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-openai-1",
      provider: "openai",
      apiKey: "sk-openai-test-key",
      isActive: true,
    });

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        object: "list",
        data: [{ id: "gpt-4o", object: "model", created: 1715368132, owned_by: "system" }],
      }),
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn-openai-1/models"), {
      params: Promise.resolve({ id: "conn-openai-1" }),
    });

    const body = await res.json();
    const modelIds = body.models.map((m) => m.id);

    // The regression: the old merge was gated on /gpt-6/i, so a dotted id like
    // "gpt-6.1-sol" and the whole gpt-5.6 line never reached the sync list.
    for (const id of [
      "gpt-6.1-sol",
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4-pro",
      "o1-pro",
    ]) {
      expect(modelIds).toContain(id);
    }

    // Media-only / kind-specific registry entries still merge (they are static
    // catalogue rows the upstream list omits), but never as duplicates.
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });
});
