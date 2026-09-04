import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import codebuddy_cnConfig from "../../open-sse/providers/registry/codebuddy-cn.js";

describe("codebuddy-cn model catalog refresh", () => {
  it("includes new models and excludes dead models in registry", () => {
    const modelIds = codebuddy_cnConfig.models.map((m) => m.id);
    expect(modelIds).toContain("hy3");
    expect(modelIds).toContain("hy3-x");
    expect(modelIds).toContain("hy4-preview");
    expect(modelIds).toContain("hy4-preview-x");
    expect(modelIds).toContain("glm-5.3");
    expect(modelIds).toContain("glm-5.3-flash");
    expect(modelIds).toContain("kimi-k3-1");

    expect(modelIds).not.toContain("glm-5.0");
    expect(modelIds).not.toContain("glm-4.7");
  });

  it("resolves capabilities for new codebuddy-cn models", () => {
    const hy3 = getCapabilitiesForModel("codebuddy-cn", "hy3");
    expect(hy3.vision).toBe(true);
    expect(hy3.reasoning).toBe(true);
    expect(hy3.contextWindow).toBe(192000);

    const hy4 = getCapabilitiesForModel("codebuddy-cn", "hy4-preview");
    expect(hy4.vision).toBe(true);
    expect(hy4.reasoning).toBe(true);
    expect(hy4.contextWindow).toBe(1000000);

    const glm53 = getCapabilitiesForModel("codebuddy-cn", "glm-5.3");
    expect(glm53.reasoning).toBe(true);
    expect(glm53.contextWindow).toBe(1000000);

    const kimi3 = getCapabilitiesForModel("codebuddy-cn", "kimi-k3-1");
    expect(kimi3.vision).toBe(true);
    expect(kimi3.reasoning).toBe(true);
    expect(kimi3.contextWindow).toBe(256000);

    // Invariant: deepseek-v4 text-only on codebuddy-cn
    const dsv4 = getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-pro");
    expect(dsv4.vision).toBe(false);
  });

  it("resolves thinking levels per model according to PATTERN_THINKING", () => {
    // glm-5.3* -> ["low", "high", "max"] (since thinkingCanDisable is false, "none" is filtered if any)
    expect(getThinkingLevels("codebuddy-cn", "glm-5.3")).toEqual(["low", "high", "max"]);

    // deepseek-v4* on codebuddy-cn -> ["low", "high", "xhigh"]
    expect(getThinkingLevels("codebuddy-cn", "deepseek-v4-pro")).toEqual(["low", "high", "xhigh"]);

    // hy3* -> ["low", "high"]
    expect(getThinkingLevels("codebuddy-cn", "hy3")).toEqual(["low", "high"]);

    // hy4* -> ["high"]
    expect(getThinkingLevels("codebuddy-cn", "hy4-preview")).toEqual(["high"]);
  });
});
