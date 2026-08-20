import { describe, it, expect } from "vitest";
import { providerSupportsModelSync } from "../../src/shared/constants/providers.js";
import opencodeRegistry from "open-sse/providers/registry/opencode.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

describe("OpenCode Model Sync Support", () => {
  it("should confirm providerSupportsModelSync returns true for opencode", () => {
    expect(providerSupportsModelSync("opencode")).toBe(true);
    expect(providerSupportsModelSync("opencode-go")).toBe(true);
  });

  it("should include all current active free models in opencode static registry", () => {
    const modelIds = opencodeRegistry.models.map((m) => m.id);
    expect(modelIds).toContain("mimo-v2.5-free");
    expect(modelIds).toContain("hy3-free");
    expect(modelIds).toContain("nemotron-3-ultra-free");
    expect(modelIds).toContain("nemotron-3.5-lightning-free");
    expect(modelIds).toContain("x-preview-f-free");
    expect(modelIds).toContain("laguna-s-2.1-free");
    expect(modelIds).toContain("muse-spark-1.2-contributor-free");
    expect(modelIds).toContain("big-pickle");
  });

  it("should resolve capabilities correctly for new free models", () => {
    const xPreviewCaps = getCapabilitiesForModel("opencode", "x-preview-f-free");
    expect(xPreviewCaps.reasoning).toBe(true);
    expect(xPreviewCaps.contextWindow).toBe(128000);

    const lagunaCaps = getCapabilitiesForModel("opencode", "laguna-s-2.1-free");
    expect(lagunaCaps.reasoning).toBe(true);

    const museCaps = getCapabilitiesForModel("opencode", "muse-spark-1.2-contributor-free");
    expect(museCaps.reasoning).toBe(true);

    const mimoCaps = getCapabilitiesForModel("opencode", "mimo-v2.5-free");
    expect(mimoCaps.vision).toBe(true);
    expect(mimoCaps.contextWindow).toBe(1048576);
  });

  it("should filter opencode-free suggested models properly", () => {
    const filterFn = FILTERS["opencode-free"];
    const rawList = [
      { id: "claude-sonnet-5" },
      { id: "mimo-v2.5-free" },
      { id: "x-preview-f-free" },
      { id: "big-pickle" },
      { id: "gpt-5" },
    ];
    const filtered = filterFn(rawList);
    expect(filtered).toEqual([
      { id: "mimo-v2.5-free", name: "mimo-v2.5-free" },
      { id: "x-preview-f-free", name: "x-preview-f-free" },
      { id: "big-pickle", name: "big-pickle" },
    ]);
  });
});
