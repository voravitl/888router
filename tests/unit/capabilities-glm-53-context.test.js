import { describe, expect, it } from "vitest";

import {
  getCapabilitiesForModel,
  resolveKnownContextWindow,
} from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import tokenrouter from "../../open-sse/providers/registry/tokenrouter.js";

// GLM-5.3 and GLM-5.3-Flash ship a 1M-token context window (Z.ai official specification).
// TokenRouter and other gateways expose it under prefixes ("z-ai/glm-5.3-free",
// "z-ai/glm-5.3", "z-ai/glm-5.3-flash") and BytePlus/bpm exposes dash/date forms ("glm-5-3-260828").
// Both dot and dash patterns (*glm-5.3*, *glm-5-3*, *glm-5.3*flash*, *glm-5-3*flash*) must
// resolve to 1M context before the generic *glm-5* (200k) fallback fires.
describe("GLM-5.3 & GLM-5.3-Flash 1M context capabilities", () => {
  const cases1M = [
    ["tokenrouter", "z-ai/glm-5.3-free"],
    ["tokenrouter", "z-ai/glm-5.3"],
    ["tokenrouter", "z-ai/glm-5.3-flash"],
    ["bpm", "glm-5-3-260828"],
    ["glm", "glm-5.3"],
    ["volcengine", "glm-5.3"],
    ["ollama", "glm-5.3"],
    ["ollama", "glm-5.3:cloud"],
    ["openrouter", "z-ai/glm-5.3"],
    ["openrouter", "z-ai/glm-5.3-flash"],
    ["codebuddy-cn", "glm-5.3"],
    ["codebuddy-cn", "glm-5.3-flash"],
  ];

  for (const [provider, model] of cases1M) {
    it(`resolves ${provider}/${model} to a 1M context window`, () => {
      expect(resolveKnownContextWindow(provider, model)).toBe(1000000);
    });
  }

  it("differentiates modalities: GLM-5.3 is text-only, GLM-5.3-Flash is natively multimodal", () => {
    const baseCaps = getCapabilitiesForModel("tokenrouter", "z-ai/glm-5.3-free");
    expect(baseCaps.vision).toBe(false);
    expect(baseCaps.reasoning).toBe(true);
    expect(baseCaps.thinkingFormat).toBe("openai-low-high-max");
    expect(baseCaps.thinkingCanDisable).toBe(false);
    expect(baseCaps.contextWindow).toBe(1000000);
    expect(baseCaps.maxOutput).toBe(128000);

    const flashCaps = getCapabilitiesForModel("tokenrouter", "z-ai/glm-5.3-flash");
    expect(flashCaps.vision).toBe(true);
    expect(flashCaps.videoInput).toBe(true);
    expect(flashCaps.pdf).toBe(true);
    expect(flashCaps.reasoning).toBe(true);
    expect(flashCaps.thinkingFormat).toBe("openai-low-high-max");
    expect(flashCaps.thinkingCanDisable).toBe(false);
    expect(flashCaps.contextWindow).toBe(1000000);
    expect(flashCaps.maxOutput).toBe(128000);
  });

  it("enforces valid thinking levels ['low', 'high', 'max'] across providers", () => {
    expect(getThinkingLevels("tokenrouter", "z-ai/glm-5.3-free")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("tokenrouter", "z-ai/glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("tokenrouter", "z-ai/glm-5.3-flash")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("glm", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("ollama", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("ollama", "glm-5.3:cloud")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("codebuddy-cn", "glm-5.3")).toEqual(["low", "high", "max"]);
  });

  it("ensures ollama provider override enforces text-only and non-disableable thinking on glm-5.3", () => {
    const ollamaCaps = getCapabilitiesForModel("ollama", "glm-5.3");
    expect(ollamaCaps.vision).toBe(false);
    expect(ollamaCaps.thinkingCanDisable).toBe(false);
    expect(ollamaCaps.thinkingFormat).toBe("openai-low-high-max");
    expect(ollamaCaps.contextWindow).toBe(1000000);
  });

  it("keeps GLM-5.1 / GLM-5 / GLM-4.7 at standard 200k context", () => {
    expect(resolveKnownContextWindow("glm", "glm-5.1")).toBe(200000);
    expect(resolveKnownContextWindow("glm", "glm-5")).toBe(200000);
    expect(resolveKnownContextWindow("glm", "glm-4.7")).toBe(200000);
    expect(resolveKnownContextWindow("tokenrouter", "z-ai/glm-5.1")).toBe(200000);
  });

  it("does not falsely bump a dash/date GLM-5.1 variant to 1M", () => {
    expect(resolveKnownContextWindow("bpm", "glm-5-1-010125")).toBe(200000);
  });

  it("includes GLM-5.3 models in TokenRouter seed registry and accurate pricing", () => {
    const modelIds = tokenrouter.models.map((m) => m.id);
    expect(modelIds).toContain("z-ai/glm-5.3");
    expect(modelIds).toContain("z-ai/glm-5.3-free");
    expect(modelIds).toContain("z-ai/glm-5.3-flash");

    const freePricing = getPricingForModel("tokenrouter", "z-ai/glm-5.3-free");
    expect(freePricing.input).toBe(0.0);
    expect(freePricing.output).toBe(0.0);

    const paidPricing = getPricingForModel("tokenrouter", "z-ai/glm-5.3");
    expect(paidPricing.input).toBe(1.4);
    expect(paidPricing.output).toBe(4.4);
    expect(paidPricing.cached).toBe(0.26);

    const flashPricing = getPricingForModel("tokenrouter", "z-ai/glm-5.3-flash");
    expect(flashPricing.input).toBe(0.075);
    expect(flashPricing.output).toBe(0.25);
    expect(flashPricing.cached).toBe(0.015);
  });
});
