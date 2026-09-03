import { beforeEach, describe, expect, it, vi } from "vitest";

// /v1/models must expose noAuth zero-config providers (aipass, opencode,
// mimo-free) even though they have no DB connection row. Keyed public
// gateways (openrouter, nousresearch, felo-web) must NOT be injected — their
// models 401 without a stored key. Regression for PR #378 review round 2:
// gating on the PROVIDERS transport barrel silently dropped aipass because
// buildTransport copies hasFree but not noAuth — the injection must iterate
// AI_PROVIDERS (which copies noAuth).

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
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: mocks.getAllModelDynamicCapabilities,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
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

async function listModelIds() {
  const { GET } = await import("../../src/app/api/v1/models/route.js");
  const res = await GET(new Request("http://localhost/v1/models"));
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.data || []).map((m) => m.id);
}

describe("/v1/models noAuth virtual connection injection (#377)", { timeout: 15000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getProviderConnections.mockReset().mockResolvedValue([]);
    mocks.getCombos.mockReset().mockResolvedValue([]);
    mocks.getCustomModels.mockReset().mockResolvedValue([]);
    mocks.getModelAliases.mockReset().mockResolvedValue({});
    mocks.getDisabledModels.mockReset().mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockReset().mockResolvedValue(new Map());
  });

  it("injects aipass models even when other providers have DB connections", async () => {
    // The normal deployment case: connections exist, but none for aipass.
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-ollama", provider: "ollama", isActive: true, providerSpecificData: {} },
    ]);

    const ids = await listModelIds();
    const aipass = ids.filter((id) => id.startsWith("ap/") || id.startsWith("aipass/"));
    expect(aipass.length).toBeGreaterThan(0);
    expect(aipass.some((id) => id.includes("gemini-3.1-flash-lite"))).toBe(true);
  });

  it("does not duplicate aipass when a real aipass connection exists", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-aipass", provider: "aipass", isActive: true, providerSpecificData: {} },
    ]);

    const ids = await listModelIds();
    const aipassGemini = ids.filter((id) => id.endsWith("/gemini-3.1-flash-lite"));
    expect(aipassGemini.length).toBe(1);
  });

  it("does not inject keyed public gateways (openrouter) without a connection", async () => {
    // The invariant: with a non-openrouter connection present (normal case),
    // openrouter models must NOT appear — the injection does not add keyed
    // gateways (they 401 without a stored key).
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-ollama", provider: "ollama", isActive: true, providerSpecificData: {} },
    ]);
    const withConn = await listModelIds();
    const orWith = withConn.filter((id) => id.startsWith("openrouter/"));
    expect(orWith.length).toBe(0);
  });
});