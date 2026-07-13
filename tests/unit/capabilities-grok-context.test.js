import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel, resolveKnownContextWindow } from "../../open-sse/providers/capabilities.js";

describe("Grok context windows", () => {
  it("grok-4.5 is 500k (not the generic grok-4 256k)", () => {
    expect(getCapabilitiesForModel("xai", "grok-4.5").contextWindow).toBe(500000);
    expect(getCapabilitiesForModel("xai", "xai/grok-4.5").contextWindow).toBe(500000);
    expect(getCapabilitiesForModel("xai", "grok-4-5").contextWindow).toBe(500000);
    expect(resolveKnownContextWindow("xai", "grok-4.5")).toBe(500000);
  });

  it("older grok-4 family still 256k", () => {
    expect(getCapabilitiesForModel("xai", "grok-4").contextWindow).toBe(256000);
    expect(getCapabilitiesForModel("xai", "grok-4-fast-reasoning").contextWindow).toBe(256000);
    expect(getCapabilitiesForModel("xai", "grok-code-fast-1").contextWindow).toBe(256000);
  });
});
