import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getModelUpstreamId, isValidModel, findModelName } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Live evidence (2026-10-04): POST :fetchAvailableModels via the gateway's own
// /api/providers/antigravity/models exposes 6 tiered Claude 5.5 IDs
// (claude-{sonnet,opus}-5-5-{high,medium,low}) and no longer lists the stale
// claude-sonnet-4-6 / claude-opus-4-6-thinking registry entries.
const SONNET_55 = ["claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low"];
const OPUS_55 = ["claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low"];

describe("Antigravity Claude 5.5 tiered identity", () => {
  it.each([...SONNET_55, ...OPUS_55])("registers and forwards %s unchanged", (model) => {
    expect(isValidModel("ag", model)).toBe(true);
    expect(getModelUpstreamId("ag", model)).toBe(model);
    expect(findModelName("ag", model)).not.toBe(model);
  });

  it("resolves 1M adaptive capabilities for tiered 5.5 IDs", () => {
    for (const model of [...SONNET_55, ...OPUS_55]) {
      expect(getCapabilitiesForModel("ag", model)).toMatchObject({
        reasoning: true,
        thinkingFormat: "claude-adaptive",
        contextWindow: 1000000,
        maxOutput: 128000,
      });
    }
  });

  it("forwards tiered 5.5 through the executor without rewriting", () => {
    const executor = new AntigravityExecutor();
    for (const model of ["claude-sonnet-5-5-high", "claude-opus-5-5-low"]) {
      const result = executor.transformRequest(model, {
        request: { contents: [], generationConfig: {} },
      }, false, { projectId: "test-project" });
      expect(result.model).toBe(model);
    }
  });

  it.each(["claude-sonnet-4-6", "claude-opus-4-6-thinking"])("rejects stale %s absent from live backend", (model) => {
    expect(isValidModel("ag", model)).toBe(false);
  });
});
