import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clearModelsDevCache } from "../../open-sse/services/modelsDevModality.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import {
  resolveOpenCodeGoModels,
  resetOpenCodeGoCatalogForTests,
} from "../../open-sse/services/opencodeGoModels.js";

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

// zen/go /v1/models carries only id/object/created/owned_by — no capability hints.
const ZEN_FIXTURE = {
  object: "list",
  data: [
    { id: "mimo-v2.6-pro", object: "model", created: 1735689600, owned_by: "opencode" },
    { id: "glm-4.7", object: "model", created: 1735689600, owned_by: "opencode" },
    { id: "totally-new-go-model", object: "model", created: 1735689600, owned_by: "opencode" },
  ],
};

// models.dev "opencode-go" block — the missing mirror of the opencode special-case.
const MODELS_DEV_FIXTURE = {
  "opencode-go": {
    models: {
      "mimo-v2.6-pro": {
        modalities: { input: ["text", "image"] },
        reasoning: true,
        limit: { context: 1048576, output: 131072 },
      },
      "glm-4.7": {
        modalities: { input: ["text"] },
        reasoning: true,
        limit: { context: 204800, output: 32768 },
      },
    },
  },
};

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

describe("opencode-go model sync enriches context from models.dev", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearModelsDevCache();
  });

  it("returns models.dev context window and modality flags for synced models", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-oc-go-1",
      provider: "opencode-go",
      apiKey: "oc_sk_test_go",
      isActive: true,
    });

    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).startsWith("https://opencode.ai/zen/go/v1/models")) {
        return jsonResponse(ZEN_FIXTURE);
      }
      if (String(url).includes("models.dev/api.json")) {
        return jsonResponse(MODELS_DEV_FIXTURE);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(
      new Request("http://localhost/api/providers/conn-oc-go-1/models"),
      { params: Promise.resolve({ id: "conn-oc-go-1" }) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const mimo = body.models.find((m) => m.id === "mimo-v2.6-pro");
    expect(mimo.context_length).toBe(1048576);
    expect(mimo.contextWindow).toBe(1048576);
    expect(mimo.vision).toBe(true);
    expect(mimo.reasoning).toBe(true);

    const glm = body.models.find((m) => m.id === "glm-4.7");
    expect(glm.context_length).toBe(204800);
  });

  it("persists models.dev context into provider-scoped dynamic capabilities", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-oc-go-1",
      provider: "opencode-go",
      apiKey: "oc_sk_test_go",
      isActive: true,
    });

    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).startsWith("https://opencode.ai/zen/go/v1/models")) {
        return jsonResponse(ZEN_FIXTURE);
      }
      if (String(url).includes("models.dev/api.json")) {
        return jsonResponse(MODELS_DEV_FIXTURE);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(
      new Request("http://localhost/api/providers/conn-oc-go-1/models"),
      { params: Promise.resolve({ id: "conn-oc-go-1" }) }
    );
    expect(res.status).toBe(200);

    expect(mocks.saveModelDynamicCapabilities).toHaveBeenCalledWith(
      "opencode-go",
      "mimo-v2.6-pro",
      expect.objectContaining({ contextWindow: 1048576 })
    );
  });

  it("clones static fallback entries so enrichment never mutates the registry", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-oc-go-1",
      provider: "opencode-go",
      apiKey: "oc_sk_test_go",
      isActive: true,
    });

    // zen answers 200 but with an empty list → the route serves static seed
    // clones enriched from models.dev; the registry objects themselves must
    // stay pristine for the next request.
    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).startsWith("https://opencode.ai/zen/go/v1/models")) {
        return jsonResponse({ object: "list", data: [] });
      }
      if (String(url).includes("models.dev/api.json")) {
        return jsonResponse(MODELS_DEV_FIXTURE);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const before = structuredClone(PROVIDERS["opencode-go"].models);

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(
      new Request("http://localhost/api/providers/conn-oc-go-1/models"),
      { params: Promise.resolve({ id: "conn-oc-go-1" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.length).toBeGreaterThan(0);

    expect(PROVIDERS["opencode-go"].models).toEqual(before);
  });

  it("leaves models missing from models.dev untouched", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-oc-go-1",
      provider: "opencode-go",
      apiKey: "oc_sk_test_go",
      isActive: true,
    });

    mocks.fetch.mockImplementation(async (url) => {
      if (String(url).startsWith("https://opencode.ai/zen/go/v1/models")) {
        return jsonResponse(ZEN_FIXTURE);
      }
      if (String(url).includes("models.dev/api.json")) {
        return jsonResponse(MODELS_DEV_FIXTURE);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

    const res = await GET(
      new Request("http://localhost/api/providers/conn-oc-go-1/models"),
      { params: Promise.resolve({ id: "conn-oc-go-1" }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const unknown = body.models.find((m) => m.id === "totally-new-go-model");
    expect(unknown.context_length).toBeUndefined();
    expect(unknown.contextWindow).toBeUndefined();
    expect(unknown.vision).toBeUndefined();
    expect(unknown.reasoning).toBeUndefined();
  });
});

describe("opencode go live catalog attaches models.dev capabilities for /v1/models", () => {
  let modelsDevFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    clearModelsDevCache();
    resetOpenCodeGoCatalogForTests();
    modelsDevFetch = vi.fn(async (url) => {
      if (String(url).includes("models.dev/api.json")) {
        return jsonResponse(MODELS_DEV_FIXTURE);
      }
      if (String(url).startsWith("https://opencode.ai/zen/go/v1/models")) {
        return jsonResponse(ZEN_FIXTURE);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", modelsDevFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches capabilities for models present in models.dev", async () => {
    const result = await resolveOpenCodeGoModels({
      fetchImpl: () => Promise.resolve(jsonResponse(ZEN_FIXTURE)),
    });

    const mimo = result.models.find((m) => m.id === "mimo-v2.6-pro");
    expect(mimo.capabilities).toEqual({ contextWindow: 1048576, vision: true, reasoning: true });

    const glm = result.models.find((m) => m.id === "glm-4.7");
    expect(glm.capabilities).toBeDefined();
    expect(glm.capabilities.contextWindow).toBe(204800);
  });

  it("keeps bare shape for models missing from models.dev", async () => {
    const result = await resolveOpenCodeGoModels({
      fetchImpl: () => Promise.resolve(jsonResponse(ZEN_FIXTURE)),
    });

    const unknown = result.models.find((m) => m.id === "totally-new-go-model");
    expect(unknown.capabilities).toBeUndefined();
  });
});
