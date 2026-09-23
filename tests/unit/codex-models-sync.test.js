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

describe("Codex Provider Model Sync (GPT-6 Astra, Sol, Luna Support)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches codex models with client_version=0.156.1 and generates review pairs", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-codex-1",
      provider: "codex",
      accessToken: "codex-test-token",
      isActive: true,
    });

    // Mock upstream response returning GPT-6 models
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6-Astra",
            max_context_window: 872000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
          },
          {
            slug: "gpt-6-sol",
            display_name: "GPT-6-Sol",
            max_context_window: 872000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium" }, { effort: "ultra" }],
          },
          {
            slug: "gpt-6-luna",
            display_name: "GPT-6-Luna",
            max_context_window: 872000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium" }],
          },
          {
            slug: "gpt-reserve",
            display_name: "GPT-Reserve",
            max_context_window: 872000,
            input_modalities: ["text", "image"],
          },
        ],
      }),
    });

    const { GET, CODEX_CLI_CLIENT_VERSION } = await import("../../src/app/api/providers/[id]/models/route.js");
    expect(CODEX_CLI_CLIENT_VERSION).toBe("0.156.1");

    const res = await GET(new Request("http://localhost/api/providers/conn-codex-1/models"), {
      params: Promise.resolve({ id: "conn-codex-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify correct URL and headers
    const [calledUrl, calledInit] = mocks.fetch.mock.calls[0];
    expect(calledUrl).toContain("https://chatgpt.com/backend-api/codex/models?client_version=0.156.1");
    expect(calledInit.headers.Authorization).toBe("Bearer codex-test-token");
    expect(calledInit.headers.originator).toBe("codex_cli_rs");

    const modelIds = body.models.map((m) => m.id);

    // Primary models present
    expect(modelIds).toContain("gpt-6-astra");
    expect(modelIds).toContain("gpt-6-sol");
    expect(modelIds).toContain("gpt-6-luna");
    expect(modelIds).toContain("gpt-reserve");

    // Auto-generated review pairs present
    expect(modelIds).toContain("gpt-6-astra-review");
    expect(modelIds).toContain("gpt-6-sol-review");
    expect(modelIds).toContain("gpt-6-luna-review");
    expect(modelIds).toContain("gpt-reserve-review");

    // Dynamic caps saved for GPT-6 Sol
    expect(mocks.saveModelDynamicCapabilities).toHaveBeenCalledWith(
      "codex",
      "gpt-6-sol",
      expect.objectContaining({ contextWindow: 872000, vision: true })
    );

    // Dynamic caps saved for GPT-6 Luna
    expect(mocks.saveModelDynamicCapabilities).toHaveBeenCalledWith(
      "codex",
      "gpt-6-luna",
      expect.objectContaining({ contextWindow: 872000, vision: true })
    );

    // Stamped into synced models kv
    expect(mocks.stampSyncedModels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: "conn-codex-1", modelId: "gpt-6-sol" }),
        expect.objectContaining({ connectionId: "conn-codex-1", modelId: "gpt-6-luna" }),
      ])
    );
  });

  it("merges static GPT-6 models from registry into codex models when upstream returns standard list", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-codex-2",
      provider: "codex",
      accessToken: "codex-test-token-2",
      isActive: true,
    });

    // Upstream returns older list without gpt-6-sol / gpt-6-luna
    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", max_context_window: 872000 },
        ],
      }),
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn-codex-2/models"), {
      params: Promise.resolve({ id: "conn-codex-2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const modelIds = body.models.map((m) => m.id);

    // Upstream model present
    expect(modelIds).toContain("gpt-5.6-sol");
    expect(modelIds).toContain("gpt-5.6-sol-review");

    // Static registry GPT-6 models merged
    expect(modelIds).toContain("gpt-6-astra");
    expect(modelIds).toContain("gpt-6-sol");
    expect(modelIds).toContain("gpt-6-luna");
  });
});
