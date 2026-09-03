import { describe, it, expect, beforeEach, vi } from "vitest";
import { extractModels } from "../../open-sse/services/aipassBridge.js";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  listAipassModels: vi.fn(),
  hasConnectedClients: vi.fn(),
  stampSyncedModels: vi.fn(),
  getSyncedModelsMap: vi.fn(),
  saveModelDynamicCapabilities: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: vi.fn().mockResolvedValue([]),
}));

vi.mock("open-sse/services/aipassBridge.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listAipassModels: mocks.listAipassModels,
    hasConnectedClients: mocks.hasConnectedClients,
  };
});

vi.mock("@/lib/db", () => ({
  stampSyncedModels: mocks.stampSyncedModels,
  getSyncedModelsMap: mocks.getSyncedModelsMap,
  saveModelDynamicCapabilities: mocks.saveModelDynamicCapabilities,
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

async function callRoute(providerOrConnId) {
  const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
  const res = await GET(new Request(`http://localhost/api/providers/${providerOrConnId}/models`), {
    params: Promise.resolve({ id: providerOrConnId }),
  });
  return { res, body: await res.json() };
}

describe("AiPASS models route & sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.stampSyncedModels.mockResolvedValue(undefined);
    mocks.getSyncedModelsMap.mockResolvedValue({});
  });

  it("extractModels normalizes chat and research kinds to llm", () => {
    const rawData = [
      {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        ready: true,
        selectable: true,
      },
      {
        id: "sonar-deep-research",
        name: "Sonar Deep Research",
        ready: true,
        selectable: true,
      },
      {
        id: "gpt-image-2",
        name: "GPT-Image-2",
        ready: true,
        selectable: true,
      },
    ];

    const models = extractModels(rawData);
    const gemini = models.find((m) => m.id === "gemini-3.7-flash");
    const sonar = models.find((m) => m.id === "sonar-deep-research");
    const gptImage = models.find((m) => m.id === "gpt-image-2");

    expect(gemini.kind).toBe("llm");
    expect(sonar.kind).toBe("llm");
    expect(gptImage.kind).toBe("image");
  });

  it("returns live models from bridge and stamps synced status when extension connected", async () => {
    mocks.hasConnectedClients.mockReturnValue(true);
    mocks.listAipassModels.mockResolvedValue([
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (AiPASS)", kind: "llm" },
      { id: "claude-sonnet-5@default", name: "Claude Sonnet 5 (AiPASS)", kind: "llm" },
      { id: "Kimi-K2.7-Code", name: "Kimi K2.7 Code", kind: "llm" },
    ]);

    const { res, body } = await callRoute("aipass");

    expect(res.status).toBe(200);
    expect(body.provider).toBe("aipass");
    expect(body.connectionId).toBe("public:aipass");
    expect(body.warning).toBeUndefined();

    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("gemini-3.7-flash");
    expect(ids).toContain("claude-sonnet-5@default");
    expect(ids).toContain("Kimi-K2.7-Code");
    // Merged with missing static models
    expect(ids).toContain("gemini-3.1-flash-lite");

    expect(mocks.listAipassModels).toHaveBeenCalledWith({ force: true });
    expect(mocks.stampSyncedModels).toHaveBeenCalled();
  });

  it("returns live models and stamps status for aipass-virtual (dashboard connection id)", async () => {
    mocks.hasConnectedClients.mockReturnValue(true);
    mocks.listAipassModels.mockResolvedValue([
      { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash (AiPASS)", kind: "llm" },
      { id: "claude-sonnet-5@default", name: "Claude Sonnet 5 (AiPASS)", kind: "llm", thinking: ["low", "medium", "high"] },
      { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", kind: "llm", thinking: null },
    ]);

    const { res, body } = await callRoute("aipass-virtual");

    expect(res.status).toBe(200);
    expect(body.provider).toBe("aipass");
    expect(body.connectionId).toBe("aipass-virtual");
    expect(body.warning).toBeUndefined();

    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("gemini-3.7-flash");
    expect(ids).toContain("claude-sonnet-5@default");
    expect(ids).toContain("sonar-reasoning-pro");

    expect(mocks.stampSyncedModels).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: "aipass-virtual",
          modelId: "gemini-3.7-flash",
        }),
      ])
    );
  });

  it("extractModels excludes arbitrary non-model objects that happen to have an id", () => {
    const rawData = [
      { id: "conversation-1234", text: "hello world" },
      { id: "user-5678", email: "foo@bar.com" },
      { id: "valid-model", displayName: "Valid Model", ready: true, selectable: true },
    ];
    const models = extractModels(rawData);
    expect(models.map((m) => m.id)).toEqual(["valid-model"]);
  });

  it("does NOT stamp synced models when extension is disconnected", async () => {
    mocks.hasConnectedClients.mockReturnValue(false);
    mocks.listAipassModels.mockResolvedValue([]);

    const { res, body } = await callRoute("aipass-virtual");

    expect(res.status).toBe(200);
    expect(body.provider).toBe("aipass");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.warning).toMatch(/Chrome extension not connected/);
    expect(mocks.stampSyncedModels).not.toHaveBeenCalled();
  });

  it("returns static models with warning when extension is not connected", async () => {
    mocks.hasConnectedClients.mockReturnValue(false);
    mocks.listAipassModels.mockResolvedValue([]);

    const { res, body } = await callRoute("aipass");

    expect(res.status).toBe(200);
    expect(body.provider).toBe("aipass");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.warning).toMatch(/Chrome extension not connected/);
    expect(mocks.stampSyncedModels).not.toHaveBeenCalled();
  });

  it("gracefully falls back to static models when bridge throws an error", async () => {
    mocks.hasConnectedClients.mockReturnValue(true);
    mocks.listAipassModels.mockRejectedValue(new Error("Bridge SSE connection closed"));

    const { res, body } = await callRoute("aipass");

    expect(res.status).toBe(200);
    expect(body.provider).toBe("aipass");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.warning).toMatch(/Bridge SSE connection closed/);
    expect(mocks.stampSyncedModels).not.toHaveBeenCalled();
  });

  it("does not poison dynamic capabilities with reasoning: false when thinking is null", async () => {
    mocks.hasConnectedClients.mockReturnValue(true);
    mocks.listAipassModels.mockResolvedValue([
      { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", kind: "llm", thinking: null },
      { id: "claude-sonnet-5@default", name: "Claude Sonnet 5", kind: "llm", thinking: ["low", "medium"] },
    ]);

    await callRoute("aipass-virtual");

    const calls = mocks.saveModelDynamicCapabilities.mock.calls;
    const sonarCall = calls.find((c) => c[1] === "sonar-reasoning-pro");
    if (sonarCall) {
      expect(sonarCall[2].reasoning).not.toBe(false);
    }
    const claudeCall = calls.find((c) => c[1] === "claude-sonnet-5@default");
    expect(claudeCall).toBeDefined();
    expect(claudeCall[2].reasoning).toBe(true);
  });
});
