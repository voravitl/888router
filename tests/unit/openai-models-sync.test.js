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

    // Static registry GPT-6 models merged
    expect(modelIds).toContain("gpt-6");
    expect(modelIds).toContain("gpt-6-mini");
    expect(modelIds).toContain("gpt-6-nano");
    expect(modelIds).toContain("gpt-6-codex");
    expect(modelIds).toContain("gpt-6-preview");
    expect(modelIds).toContain("gpt-6-pro");

    // Dynamic caps saved for GPT-6
    expect(mocks.saveModelDynamicCapabilities).toHaveBeenCalledWith(
      "openai",
      "gpt-6",
      expect.objectContaining({ contextWindow: 1050000, vision: true, reasoning: true })
    );

    // Stamped into synced models kv
    expect(mocks.stampSyncedModels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: "conn-openai-1", modelId: "gpt-6" }),
      ])
    );
  });
});
