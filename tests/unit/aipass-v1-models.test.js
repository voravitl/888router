import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  listAipassModels: vi.fn(),
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

vi.mock("open-sse/services/aipassBridge.js", () => ({
  listAipassModels: mocks.listAipassModels,
  hasConnectedClients: vi.fn(() => true),
}));

vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/kimchiModels.js", () => ({
  resolveKimchiModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/copilotModels.js", () => ({
  resolveCopilotModels: vi.fn(async () => null),
}));
vi.mock("open-sse/services/clinepassModels.js", () => ({
  resolveClinepassModels: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
}));

describe("v1/models — AiPASS live model resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes live AiPASS models merged with static models in /v1/models", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-ollama", provider: "ollama", isActive: true, providerSpecificData: {} },
    ]);
    mocks.listAipassModels.mockResolvedValue([
      { id: "Kimi-K2.7-Code", name: "Kimi K2.7 Code", kind: "llm" },
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", kind: "llm" },
    ]);

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id);

    // Dynamic live models
    expect(ids.some((id) => id === "ap/Kimi-K2.7-Code" || id === "aipass/Kimi-K2.7-Code")).toBe(true);
    expect(ids.some((id) => id === "ap/gemini-3.7-flash" || id === "aipass/gemini-3.7-flash")).toBe(true);
    // Merged static fallback models
    expect(ids.some((id) => id === "ap/gemini-3.1-flash-lite" || id === "aipass/gemini-3.1-flash-lite")).toBe(true);
  });
});
