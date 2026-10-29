import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetScopedDynamicCache,
  getCapabilitiesForModel,
  registerDynamicCapabilitiesScoped,
  resolveKnownContextWindow,
  resolveKnownLimits,
} from "../../open-sse/providers/capabilities.js";

describe("provider alias normalization for model capabilities", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
  });

  it("resolves dynamic capabilities registered with canonical ID when queried by alias (oc -> opencode)", () => {
    registerDynamicCapabilitiesScoped("opencode", "deepseek-v4.1-flash-free", {
      contextWindow: 200000,
      vision: true,
    });

    // Query using alias "oc"
    const capsAlias = getCapabilitiesForModel("oc", "deepseek-v4.1-flash-free");
    expect(capsAlias.contextWindow).toBe(200000);
    expect(capsAlias.vision).toBe(true);

    const cwAlias = resolveKnownContextWindow("oc", "deepseek-v4.1-flash-free");
    expect(cwAlias).toBe(200000);

    const limitsAlias = resolveKnownLimits("oc", "deepseek-v4.1-flash-free");
    expect(limitsAlias.contextWindow).toBe(200000);

    // Query using canonical ID "opencode"
    const capsCanonical = getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free");
    expect(capsCanonical.contextWindow).toBe(200000);
    expect(capsCanonical.vision).toBe(true);

    const cwCanonical = resolveKnownContextWindow("opencode", "deepseek-v4.1-flash-free");
    expect(cwCanonical).toBe(200000);
  });

  it("resolves dynamic capabilities registered with alias when queried by canonical ID or alias", () => {
    registerDynamicCapabilitiesScoped("oc", "deepseek-v4.1-flash-free", {
      contextWindow: 150000,
      vision: true,
    });

    // Query using canonical ID "opencode"
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free").contextWindow).toBe(150000);
    expect(resolveKnownContextWindow("opencode", "deepseek-v4.1-flash-free")).toBe(150000);

    // Query using alias "oc"
    expect(getCapabilitiesForModel("oc", "deepseek-v4.1-flash-free").contextWindow).toBe(150000);
    expect(resolveKnownContextWindow("oc", "deepseek-v4.1-flash-free")).toBe(150000);
  });

  it("supports other known provider aliases (ag, th, cc, cx)", () => {
    const pairs = [
      { alias: "ag", canonical: "antigravity", model: "custom-ag-model" },
      { alias: "th", canonical: "tokenharbor", model: "custom-th-model" },
      { alias: "cc", canonical: "claude", model: "custom-cc-model" },
      { alias: "cx", canonical: "codex", model: "custom-cx-model" },
    ];

    for (const { alias, canonical, model } of pairs) {
      registerDynamicCapabilitiesScoped(canonical, model, {
        contextWindow: 123456,
        reasoning: true,
      });

      // Query by alias
      const aliasCaps = getCapabilitiesForModel(alias, model);
      expect(aliasCaps.contextWindow).toBe(123456);
      expect(aliasCaps.reasoning).toBe(true);
      expect(resolveKnownContextWindow(alias, model)).toBe(123456);

      // Query by canonical
      const canCaps = getCapabilitiesForModel(canonical, model);
      expect(canCaps.contextWindow).toBe(123456);
      expect(canCaps.reasoning).toBe(true);
      expect(resolveKnownContextWindow(canonical, model)).toBe(123456);
    }
  });
});
