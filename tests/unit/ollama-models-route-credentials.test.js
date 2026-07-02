import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression test for the Ollama Cloud model-sync credential bug: connections
// created via /api/providers store the Ollama Cloud API key in `apiKey`, not
// `accessToken` (see src/app/api/providers/route.js). The models route must
// fall back to `connection.apiKey` when `accessToken` is absent.

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  listAvailableModels: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/oauth/services/ollama", () => ({
  OllamaService: vi.fn().mockImplementation(function () {
    this.listAvailableModels = mocks.listAvailableModels;
  }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

describe("Ollama models route — credential resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses connection.apiKey when accessToken is not set", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ollama-1",
      provider: "ollama",
      apiKey: "ollama-api-key-123",
    });
    mocks.listAvailableModels.mockResolvedValue([
      { id: "glm-5.2:cloud", name: "GLM 5.2 Cloud" },
      { id: "deepseek-v4-pro:cloud", name: "DeepSeek v4 Pro" },
    ]);

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-ollama-1/models"), {
      params: Promise.resolve({ id: "conn-ollama-1" }),
    });
    const body = await res.json();

    expect(mocks.listAvailableModels).toHaveBeenCalledWith("ollama-api-key-123");
    expect(body.models).toHaveLength(2);
    expect(body.models.map((m) => m.id)).toEqual(["glm-5.2:cloud", "deepseek-v4-pro:cloud"]);
    expect(body.warning).toBeUndefined();
  });

  it("still reports 'No Ollama API key found' when neither credential is set", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ollama-2",
      provider: "ollama",
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(new Request("http://localhost/api/providers/conn-ollama-2/models"), {
      params: Promise.resolve({ id: "conn-ollama-2" }),
    });
    const body = await res.json();

    expect(mocks.listAvailableModels).not.toHaveBeenCalled();
    expect(body.models).toEqual([]);
    expect(body.warning).toBe("No Ollama API key found");
  });
});
