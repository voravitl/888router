import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CAPABILITIES,
  getCapabilitiesForModel,
  registerDynamicCapabilities,
  resolveKnownContextWindow,
} from "../../open-sse/providers/capabilities.js";

// The provider sync records ONLY these three fields
// (src/app/api/providers/[id]/models/route.js), which is what made the bug
// systemic: every synced model silently lost every other capability.
const SYNC_SHAPE = { contextWindow: 1000000, vision: true, reasoning: true };

// Dynamic caps used to be merged over DEFAULT_CAPABILITIES *instead of* the
// static entry, so any field the sync did not carry fell back to the floor:
// kr/claude-opus-5 advertised max_tokens 64000 while its own MODEL_CAPABILITIES
// entry says 128000, and its -thinking variants — never synced, so never
// overwritten — correctly reported 128000 (#283).
describe("dynamic capabilities layer over static, not instead of it (#283)", () => {
  beforeEach(() => {
    // Re-register per test; the cache is module-level and intentionally sticky.
    registerDynamicCapabilities("claude-opus-5", SYNC_SHAPE);
    registerDynamicCapabilities("claude-sonnet-5", SYNC_SHAPE);
  });

  it("keeps maxOutput from the static entry when the sync omits it", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
      expect(getCapabilitiesForModel("kiro", model).maxOutput, model).toBe(128000);
    }
  });

  it("does not fall back to the DEFAULT floor for a synced model", () => {
    const caps = getCapabilitiesForModel("kiro", "claude-opus-5");
    expect(caps.maxOutput).not.toBe(DEFAULT_CAPABILITIES.maxOutput);
  });

  it("keeps the other static fields the sync never carries", () => {
    const caps = getCapabilitiesForModel("kiro", "claude-opus-5");
    expect(caps.thinkingFormat).toBe("claude-adaptive");
    expect(caps.search).toBe(true);
  });

  // The regression's tell: a synced base and its unsynced variant disagreed
  // about a value that comes from the same place.
  it("makes a synced base agree with its unsynced variants", () => {
    const base = getCapabilitiesForModel("kiro", "claude-opus-5");
    for (const variant of [
      "claude-opus-5-thinking",
      "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic",
    ]) {
      const caps = getCapabilitiesForModel("kiro", variant);
      expect(caps.maxOutput, variant).toBe(base.maxOutput);
      expect(caps.contextWindow, variant).toBe(base.contextWindow);
    }
  });

  it("still lets dynamic caps WIN on the fields they do carry", () => {
    // The whole point of the dynamic layer: upstream knows something newer.
    registerDynamicCapabilities("claude-opus-4.8", { contextWindow: 250000 });
    const caps = getCapabilitiesForModel("kiro", "claude-opus-4.8");
    expect(caps.contextWindow).toBe(250000); // dynamic overrides static 1M
    expect(caps.maxOutput).toBe(128000); // static survives
  });

  it("lets dynamic caps override a boolean to false", () => {
    // Merge order must respect an explicit false, not treat it as absent.
    registerDynamicCapabilities("claude-opus-4.7", { vision: false });
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.7").vision).toBe(false);
  });

  it("serves a dynamic-only model that the static table does not know", () => {
    registerDynamicCapabilities("brand-new-model-9", { contextWindow: 555000, vision: true });
    const caps = getCapabilitiesForModel("x", "brand-new-model-9");
    expect(caps.contextWindow).toBe(555000);
    expect(caps.vision).toBe(true);
    // Unknown elsewhere, so the floor is correct for the rest.
    expect(caps.maxOutput).toBe(DEFAULT_CAPABILITIES.maxOutput);
  });

  it("still returns the floor for a genuinely unknown model", () => {
    const caps = getCapabilitiesForModel("kiro", "totally-unknown-xyz-model");
    expect(caps.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);
    expect(caps.maxOutput).toBe(DEFAULT_CAPABILITIES.maxOutput);
    expect(caps.vision).toBe(false);
  });

  it("leaves resolveKnownContextWindow behaving as before", () => {
    // That resolver reads a single field rather than spreading the object, so it
    // never had this bug — pin it so the refactor did not change it.
    expect(resolveKnownContextWindow("kiro", "claude-opus-5")).toBe(1000000);
    expect(resolveKnownContextWindow("kiro", "totally-unknown-xyz-model")).toBeUndefined();
  });

  it("keeps provider-specific overrides winning over the static table", () => {
    // PROVIDER_CAPABILITIES is the most specific static source; the refactor
    // must not have demoted it.
    const caps = getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-pro");
    expect(caps.vision).toBe(false);
  });
});
