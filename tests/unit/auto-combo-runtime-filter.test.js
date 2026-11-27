import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerDynamicCapabilitiesScoped,
  __resetScopedDynamicCache,
} from "../../open-sse/providers/capabilities.js";
import { resolveVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.js";
import opencodeRegistry from "../../open-sse/providers/registry/opencode.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getSyncedModelsMap: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  getModelAliases: vi.fn(async () => ({})),
  getComboByName: vi.fn(async () => null),
  getProviderNodes: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getModelAliases: mocks.getModelAliases,
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
}));

vi.mock("@/lib/db", () => ({
  getSyncedModelsMap: mocks.getSyncedModelsMap,
  getAllModelDynamicCapabilities: mocks.getAllModelDynamicCapabilities,
}));

const { getComboModels } = await import("../../src/sse/services/model.js");

describe("auto/* runtime active-provider filtering, dynamic bleed guard, and OpenCode catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetScopedDynamicCache();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getSyncedModelsMap.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
  });

  afterEach(() => {
    __resetScopedDynamicCache();
  });

  it("getComboModels('auto/best-free-1m') drops unconnected providers when active DB connections exist", async () => {
    registerDynamicCapabilitiesScoped("openrouter", "nvidia/nemotron-3-super:free", {
      contextWindow: 1000000,
      reasoning: true,
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-or", provider: "openrouter", isActive: true, apiKey: "sk-or-test" },
      { id: "conn-ocg", provider: "opencode-go", isActive: true, apiKey: "sk-ocg-test" },
    ]);

    const models = await getComboModels("auto/best-free-1m");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    // Unconnected providers must not be walked at runtime
    expect(models.some((m) => m.startsWith("chatgpt-web/"))).toBe(false);
    expect(models.some((m) => m.startsWith("felo-web/"))).toBe(false);
    expect(models.some((m) => m.startsWith("freebuff/"))).toBe(false);
    expect(models.some((m) => m.startsWith("aihubmix/"))).toBe(false);
    expect(models.some((m) => m.startsWith("nara/"))).toBe(false);
    expect(models.some((m) => m.startsWith("bazaarlink/"))).toBe(false);
    expect(models.some((m) => m.startsWith("api-airforce/"))).toBe(false);

    // Connected + noAuth free providers remain
    expect(models.some((m) => m.startsWith("opencode/"))).toBe(true);
    expect(models.some((m) => m.startsWith("opencode-go/"))).toBe(true);
    expect(models).toContain("openrouter/nvidia/nemotron-3-super:free");
  });

  it("getComboModels('auto/best-free-1m') falls back to full virtual catalog when zero connections exist", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const models = await getComboModels("auto/best-free-1m");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(20);
  });

  it("resolveVirtualAutoCombo blocks vendor-stripped dynamic cache bleed and retired OpenCode ids", () => {
    // Simulate capabilityKey() storing vendor-stripped keys in dynamic cache
    registerDynamicCapabilitiesScoped("nousresearch", "longcat-2.0:free", {
      contextWindow: 1000000,
      reasoning: true,
    });
    registerDynamicCapabilitiesScoped("openrouter", "nemotron-3.5-lightning:free", {
      contextWindow: 1000000,
      reasoning: true,
    });
    registerDynamicCapabilitiesScoped("opencode", "x-preview-f-free", {
      contextWindow: 1000000,
      reasoning: true,
      vision: true,
    });

    const combo = resolveVirtualAutoCombo("auto/best-free-1m");
    expect(combo).not.toBeNull();
    expect(combo.models).not.toContain("nousresearch/longcat-2.0:free");
    expect(combo.models).not.toContain("openrouter/nemotron-3.5-lightning:free");
    expect(combo.models).not.toContain("opencode/x-preview-f-free");
  });

  it("getComboModels excludes dynamic-only models marked stale in syncedModels", async () => {
    const staleTag = "ghost-stale-free-model";
    registerDynamicCapabilitiesScoped("opencode", staleTag, {
      contextWindow: 1000000,
      reasoning: true,
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-oc", provider: "opencode", isActive: true, apiKey: "sk-oc" },
    ]);
    mocks.getSyncedModelsMap.mockResolvedValue({
      [`conn-oc:${staleTag}`]: { status: "stale", missingSince: "2026-11-27T00:00:00Z" },
    });

    const models = await getComboModels("auto/best-free-1m");
    expect(models).not.toContain(`opencode/${staleTag}`);
  });

  it("opencode registry drops retired ids (longcat-2.5-free, inkling-2-small-free, tidepool-alpha-free) and includes live seaglass-alpha-free", () => {
    const ids = opencodeRegistry.models.map((m) => m.id);
    expect(ids).not.toContain("longcat-2.5-free");
    expect(ids).not.toContain("inkling-2-small-free");
    expect(ids).not.toContain("tidepool-alpha-free");
    expect(ids).toContain("seaglass-alpha-free");

    const caps = getCapabilitiesForModel("opencode", "seaglass-alpha-free");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(131072);
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(false);
  });
});
