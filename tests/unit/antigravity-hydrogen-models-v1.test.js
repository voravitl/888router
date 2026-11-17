import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(async () => {}),
  fetch: vi.fn(),
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

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: mocks.refreshGoogleToken,
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      json: async () => body,
    }),
  },
}));

const JUNK_AND_RETIRED_IDS = [
  "ag/gemini-4-hydrogen-tiered",
  "ag/gemini-4-hydrogen-tiered-xhigh",
  "ag/gemini-4-hydrogen-tiered-high",
  "ag/gemini-4-hydrogen-tiered-medium",
  "ag/gemini-4-hydrogen-tiered-low",
  "ag/gemini-4-hydrogen-sonar",
  "ag/gemini-4-carbon-disabled",
  "ag/tab_jump_flash_lite_preview",
  "ag/tab_flash_lite_preview",
  "ag/gemini-3.6-flash-tiered",
  "ag/gemini-3.6-flash-high",
  "ag/gemini-3.6-flash-medium",
  "ag/gemini-3.6-flash-low",
  "ag/gemini-3.7-flash-tiered",
  "ag/gemini-3.7-flash-high",
  "ag/gemini-3.7-flash-medium",
  "ag/gemini-3.7-flash-low",
  "ag/gemini-3.8-flash-tiered",
  "ag/internal-debug-model",
  "ag/disabled-flag-model",
];

describe("Antigravity /v1/models garbage/retired filtering and Hydrogen tiering", () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = mocks.fetch;
    mocks.getProviderConnections.mockReset().mockResolvedValue([
      {
        id: "conn-ag-1",
        provider: "antigravity",
        isActive: true,
        accessToken: "ag-access-token",
        refreshToken: "ag-refresh-token",
      },
    ]);
    mocks.getCombos.mockReset().mockResolvedValue([]);
    mocks.getCustomModels.mockReset().mockResolvedValue([]);
    mocks.getModelAliases.mockReset().mockResolvedValue({});
    mocks.getDisabledModels.mockReset().mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockReset().mockResolvedValue(new Map());
    mocks.fetch.mockReset();
  });

  it("filters junk/internal/tab/disabled/sonar/retired models from object-map fetchAvailableModels and expands tiers cleanly", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: {
          "gemini-4-hydrogen-tiered": { displayName: "Gemini 4 Hydrogen" },
          "gemini-4-hydrogen-tiered-xhigh": { displayName: "Gemini 4 Hydrogen Tiered XHigh" },
          "gemini-4-hydrogen-tiered-high": { displayName: "Gemini 4 Hydrogen Tiered High" },
          "gemini-4-hydrogen-tiered-medium": { displayName: "Gemini 4 Hydrogen Tiered Medium" },
          "gemini-4-hydrogen-tiered-low": { displayName: "Gemini 4 Hydrogen Tiered Low" },
          "gemini-4-hydrogen-sonar": { displayName: "Gemini 4 Hydrogen Sonar" },
          "gemini-4-carbon-disabled": { displayName: "Gemini 4 Carbon Disabled" },
          "tab_jump_flash_lite_preview": { displayName: "Tab Jump" },
          "tab_flash_lite_preview": { displayName: "Tab Flash" },
          "gemini-3.6-flash-tiered": { displayName: "Gemini 3.6 Flash" },
          "gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash (High)" },
          "gemini-3.7-flash-tiered": { displayName: "Gemini 3.7 Flash" },
          "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash" },
          "internal-debug-model": { displayName: "Internal Debug", isInternal: true },
          "disabled-flag-model": { displayName: "Disabled Flag", disabled: true },
        },
      }),
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id);

    for (const badId of JUNK_AND_RETIRED_IDS) {
      expect(ids, `${badId} must not be advertised by /v1/models`).not.toContain(badId);
    }

    expect(ids).toContain("ag/gemini-4-hydrogen");
    expect(ids).toContain("ag/gemini-4-hydrogen-xhigh");
    expect(ids).toContain("ag/gemini-4-hydrogen-high");
    expect(ids).toContain("ag/gemini-4-hydrogen-medium");
    expect(ids).toContain("ag/gemini-4-hydrogen-low");
    expect(ids).toContain("ag/gemini-3.8-flash-high");
    expect(ids).toContain("ag/gemini-3.8-flash-medium");
    expect(ids).toContain("ag/gemini-3.8-flash-low");
  }, 30000);

  it("applies the same filtering and tier expansion for array-shaped fetchAvailableModels payloads", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { id: "gemini-4-hydrogen-tiered", displayName: "Gemini 4 Hydrogen" },
          { id: "gemini-4-hydrogen-tiered-xhigh" },
          { id: "gemini-4-hydrogen-sonar" },
          { id: "gemini-4-carbon-disabled" },
          { id: "tab_jump_flash_lite_preview" },
          { id: "gemini-3.6-flash-tiered" },
          { id: "gemini-3.7-flash-tiered" },
          { id: "gemini-3.8-flash-tiered" },
          { id: "internal-debug-model", isInternal: true },
        ],
      }),
    });

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id);

    for (const badId of JUNK_AND_RETIRED_IDS) {
      expect(ids, `${badId} must not be advertised by /v1/models`).not.toContain(badId);
    }

    expect(ids).toContain("ag/gemini-4-hydrogen");
    expect(ids).toContain("ag/gemini-4-hydrogen-xhigh");
    expect(ids).toContain("ag/gemini-3.8-flash-high");
  }, 30000);

  it("filters stale garbage/retired ids even if saved in connection enabledModels", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-ag-1",
        provider: "antigravity",
        isActive: true,
        accessToken: "ag-access-token",
        providerSpecificData: {
          enabledModels: [
            "gemini-4-hydrogen-xhigh",
            "gemini-4-hydrogen-tiered-xhigh",
            "gemini-4-hydrogen-tiered",
            "gemini-4-hydrogen-sonar",
            "gemini-4-carbon-disabled",
            "tab_flash_lite_preview",
            "gemini-3.6-flash-high",
            "gemini-3.7-flash-tiered",
            "gemini-3.8-flash-tiered",
          ],
        },
      },
    ]);

    const { GET } = await import("../../src/app/api/v1/models/route.js");
    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id);

    expect(ids).toContain("ag/gemini-4-hydrogen-xhigh");
    for (const badId of JUNK_AND_RETIRED_IDS) {
      expect(ids, `${badId} must not leak from enabledModels`).not.toContain(badId);
    }
  }, 30000);
});

describe("Antigravity cached -tiered-* Hydrogen fallback resolution", () => {
  it.each([
    ["gemini-4-hydrogen-tiered-xhigh", "gemini-4-hydrogen-xhigh(xhigh)", "gemini-4-hydrogen-xhigh", "xhigh"],
    ["gemini-4-hydrogen-tiered-high", "gemini-4-hydrogen-high(high)", "gemini-4-hydrogen-high", "high"],
    ["gemini-4-hydrogen-tiered-medium", "gemini-4-hydrogen-medium(medium)", "gemini-4-hydrogen-medium", "medium"],
    ["gemini-4-hydrogen-tiered-low", "gemini-4-hydrogen-low(low)", "gemini-4-hydrogen-low", "low"],
    ["gemini-4-hydrogen-tiered", "gemini-4-hydrogen-high(high)", "gemini-4-hydrogen-high", "high"],
    ["gemini-4-hydrogen-high", "gemini-4-hydrogen-high(high)", "gemini-4-hydrogen-high", "high"],
    ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-medium(medium)", "gemini-4-hydrogen-medium", "medium"],
    ["gemini-4-hydrogen-low", "gemini-4-hydrogen-low(low)", "gemini-4-hydrogen-low", "low"],
    ["gemini-4-hydrogen-tiered-xhigh(low)", "gemini-4-hydrogen-xhigh(low)", "gemini-4-hydrogen-xhigh", "low"],
  ])("resolves %s → %s and wire %s with thinkingLevel=%s", async (inputId, expectedUpstream, expectedWireModel, expectedLevel) => {
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { applyThinking, stripThinkingSuffix } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    expect(getModelUpstreamId("ag", inputId)).toBe(expectedUpstream);
    expect(getModelUpstreamId("antigravity", inputId)).toBe(expectedUpstream);

    const upstream = getModelUpstreamId("ag", inputId);
    const body = {
      model: stripThinkingSuffix(upstream),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };
    applyThinking("antigravity", upstream, body, "antigravity");

    const finalBody = new AntigravityExecutor().transformRequest(upstream, body, true, { projectId: "project" });
    expect(finalBody.model).toBe(expectedWireModel);
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: expectedLevel,
      includeThoughts: true,
    });
  });

  it("handles parseAntigravityLiveModels boundary inputs and providers/[id]/models alignment", async () => {
    const { parseAntigravityLiveModels, isAntigravityHiddenModel } = await import(
      "../../open-sse/providers/models/helpers.js"
    );
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");

    expect(parseAntigravityLiveModels(null, PROVIDERS.antigravity?.models)).toEqual([]);
    expect(parseAntigravityLiveModels({ models: {} }, PROVIDERS.antigravity?.models)).toEqual([]);
    expect(
      parseAntigravityLiveModels(
        {
          models: {
            " tab_jump_flash_lite_preview ": { displayName: "Tab" },
            "gemini-4-carbon-disabled": { displayName: "Disabled" },
          },
        },
        PROVIDERS.antigravity?.models,
      ),
    ).toEqual([]);

    const synced = parseAntigravityLiveModels(
      {
        models: {
          "gemini-4-hydrogen-tiered": { displayName: "Gemini 4 Hydrogen" },
          "gemini-4-hydrogen-tiered-xhigh": { displayName: "Bad Tiered XHigh" },
          "gemini-4-argon-tiered": { displayName: "Gemini 4 Argon Tiered" },
          "gemini-4-hydrogen-sonar": { displayName: "Sonar" },
          "gemini-4-carbon-disabled": { displayName: "Carbon Disabled" },
          "tab_flash_lite_preview": { displayName: "Tab" },
          "gemini-3.6-flash-tiered": { displayName: "3.6" },
          "gemini-3.7-flash-tiered": { displayName: "3.7" },
          "gemini-3.8-flash-tiered": { displayName: "3.8" },
        },
      },
      PROVIDERS.antigravity?.models,
    );
    const syncedIds = synced.map((m) => m.id);
    expect(syncedIds).toContain("gemini-4-hydrogen");
    expect(syncedIds).toContain("gemini-4-hydrogen-xhigh");
    expect(syncedIds).toContain("gemini-4-argon-high");
    expect(syncedIds).toContain("gemini-3.8-flash-high");
    for (const id of syncedIds) {
      expect(isAntigravityHiddenModel(id), `${id} should not be hidden`).toBe(false);
    }
    expect(isAntigravityHiddenModel("")).toBe(true);
    expect(isAntigravityHiddenModel(null)).toBe(true);
  });
});
