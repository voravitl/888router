import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel, registerDynamicCapabilities, DYNAMIC_CAPABILITIES_CACHE } from "../../open-sse/providers/capabilities.js";

describe("Dynamic Model Capabilities Engine", () => {
  it("resolves dynamic metadata dynamically registered at runtime", () => {
    // Register a brand new unknown model with custom context & vision
    const customModelId = "unknown-vendor/future-super-model-v9";

    // Before registration, falls back to default floor (200k, vision: false)
    const before = getCapabilitiesForModel(null, customModelId);
    expect(before.contextWindow).toBe(200000);
    expect(before.vision).toBe(false);

    // Dynamically register extracted capabilities from upstream sync
    registerDynamicCapabilities(customModelId, {
      contextWindow: 2500000,
      vision: true,
      reasoning: true,
    });

    // After registration, Tier 2 Dynamic Lookup wins!
    const after = getCapabilitiesForModel(null, customModelId);
    expect(after.contextWindow).toBe(2500000);
    expect(after.vision).toBe(true);
    expect(after.reasoning).toBe(true);
  });
});
