import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetScopedDynamicCache,
  registerDynamicCapabilitiesScoped,
} from "../../open-sse/providers/capabilities.js";

// Mock DB dependencies for /api/models GET
vi.mock("@/models", () => ({
  getModelAliases: vi.fn(async () => ({})),
  setModelAlias: vi.fn(async () => {}),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

describe("GET /api/models route provider alias normalization", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
  });

  it("reflects synced dynamic capabilities for models whose AI_MODELS provider is an alias (oc)", async () => {
    // Register 200k dynamic capabilities under canonical provider ID 'opencode'
    registerDynamicCapabilitiesScoped("opencode", "deepseek-v4.1-flash-free", {
      contextWindow: 200000,
      vision: true,
      reasoning: true,
    });

    const { GET } = await import("../../src/app/api/models/route.js");
    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    const ocModel = data.models.find(
      (m) => m.fullModel === "oc/deepseek-v4.1-flash-free" || (m.provider === "oc" && m.model === "deepseek-v4.1-flash-free")
    );

    expect(ocModel).toBeDefined();
    // Must NOT be the wide catalogue pattern floor (1,000,000)
    expect(ocModel.caps.contextWindow).toBe(200000);
    expect(ocModel.caps.vision).toBe(true);
    expect(ocModel.caps.reasoning).toBe(true);
  });
});
