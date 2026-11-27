import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCapabilitiesForModel, resolveKnownContextWindow } from "../../open-sse/providers/capabilities.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getComboByName: vi.fn(async () => null),
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: mocks.getAllModelDynamicCapabilities,
  getModelDynamicCapabilities: vi.fn(async () => null),
  getSyncedModelsMap: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, registerDynamicCapabilitiesScoped: vi.fn() };
});

vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
const { GET: GET_INFO } = await import("../../src/app/api/v1/models/info/route.js");

describe("auto/best-free-1m capabilities and active-provider member filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
  });

  it("resolves 1M capabilities even when caller splits provider='auto' and model='best-free-1m' or 'free-1m'", () => {
    for (const model of ["best-free-1m", "free-1m"]) {
      const caps = getCapabilitiesForModel("auto", model);
      expect(caps.contextWindow).toBe(1000000);
      expect(caps.maxOutput).toBe(128000);
      expect(caps.vision).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(resolveKnownContextWindow("auto", model)).toBe(1000000);
    }
  });

  it("filters auto/best-free-1m comboMembers and context/max_tokens to active providers in /v1/models and /v1/models/info", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-anthropic",
        provider: "anthropic",
        isActive: true,
        apiKey: "sk-ant-test",
        providerSpecificData: {},
      },
    ]);

    const list = await buildModelsList(["llm"]);
    const autoFree1m = list.find((m) => m.id === "auto/best-free-1m");
    expect(autoFree1m).toBeDefined();
    expect(autoFree1m.context_window).toBe(1000000);
    // api-airforce and bazaarlink have no active connection here, while noAuth+hasFree
    // opencode is active. Inactive providers must not hijack comboMembers.
    expect(autoFree1m.comboMembers.some((id) => id.startsWith("api-airforce/"))).toBe(false);
    expect(autoFree1m.comboMembers.some((id) => id.startsWith("bazaarlink/"))).toBe(false);
    expect(autoFree1m.comboMembers.some((id) => id.startsWith("opencode/"))).toBe(true);
    // With api-airforce/bazaarlink excluded, capabilities.maxOutput matches resolved max_tokens.
    expect(autoFree1m.capabilities.maxOutput).toBe(autoFree1m.max_tokens);

    const infoRes = await GET_INFO(new Request("http://localhost/v1/models/info?id=auto/best-free-1m"));
    expect(infoRes.status).toBe(200);
    const infoBody = await infoRes.json();
    expect(infoBody.comboMembers).toEqual(autoFree1m.comboMembers);
    expect(infoBody.comboMemberCount).toBe(autoFree1m.comboMemberCount);
    expect(infoBody.max_tokens).toBe(autoFree1m.max_tokens);
    expect(infoBody.capabilities.maxOutput).toBe(autoFree1m.max_tokens);
  });

  it("falls back to full catalog members when no active connections exist", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const list = await buildModelsList(["llm"]);
    const autoFree1m = list.find((m) => m.id === "auto/best-free-1m");
    expect(autoFree1m).toBeDefined();
    expect(autoFree1m.context_window).toBe(1000000);
    expect(autoFree1m.comboMemberCount).toBeGreaterThan(20);
  });
});
