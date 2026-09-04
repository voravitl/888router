import { describe, it, expect, beforeEach } from "vitest";
import {
  getCapabilitiesForModel,
  resolveKnownContextWindow,
  resolveGptFamilyCapabilities,
  registerDynamicCapabilitiesScoped,
  __resetScopedDynamicCache,
} from "../../open-sse/providers/capabilities.js";

describe("Dynamic Codex & GPT Context Window Resolution", () => {
  beforeEach(() => {
    __resetScopedDynamicCache();
  });

  describe("resolveGptFamilyCapabilities (structural & mathematical versioning)", () => {
    it("resolves GPT-5.4+ models to 1,050,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-5.4")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.5")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.6-sol")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.6-terra")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.6-luna")?.contextWindow).toBe(1050000);
    });

    it("resolves mini/nano variants to 400,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-5.4-mini")?.contextWindow).toBe(400000);
      expect(resolveGptFamilyCapabilities("gpt-5.4-nano")?.contextWindow).toBe(400000);
    });

    it("resolves spark variants to 128,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-5.3-codex-spark")?.contextWindow).toBe(128000);
      expect(resolveGptFamilyCapabilities("gpt-5.4-spark")?.contextWindow).toBe(128000);
    });

    it("resolves gpt-reserve and codex-auto-review to 872,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-reserve")?.contextWindow).toBe(872000);
      expect(resolveGptFamilyCapabilities("codex-auto-review")?.contextWindow).toBe(872000);
      expect(resolveGptFamilyCapabilities("gpt-reserve-review")?.contextWindow).toBe(872000);
    });

    it("resolves older GPT-5.x (5.0-5.3) models to 400,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-5.3-codex")?.contextWindow).toBe(400000);
      expect(resolveGptFamilyCapabilities("gpt-5.2")?.contextWindow).toBe(400000);
      expect(resolveGptFamilyCapabilities("gpt-5.1")?.contextWindow).toBe(400000);
      expect(resolveGptFamilyCapabilities("gpt-5")?.contextWindow).toBe(400000);
    });

    it("resolves GPT-4.1 to 1,000,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-4.1")?.contextWindow).toBe(1000000);
    });

    it("resolves GPT-4 / 4o to 128,000 tokens", () => {
      expect(resolveGptFamilyCapabilities("gpt-4o")?.contextWindow).toBe(128000);
      expect(resolveGptFamilyCapabilities("gpt-4")?.contextWindow).toBe(128000);
    });

    it("FUTURE MODELS: resolves dynamically without any hardcoding", () => {
      // Future GPT-5.x releases
      expect(resolveGptFamilyCapabilities("gpt-5.7")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.7-codex")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.8")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.9-sol")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-5.10")?.contextWindow).toBe(1050000);

      // Future GPT-6 releases
      expect(resolveGptFamilyCapabilities("gpt-6")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-6.1-codex")?.contextWindow).toBe(1050000);
      expect(resolveGptFamilyCapabilities("gpt-6-mini")?.contextWindow).toBe(400000);
      expect(resolveGptFamilyCapabilities("gpt-6-spark")?.contextWindow).toBe(128000);

      // Future GPT-7 releases
      expect(resolveGptFamilyCapabilities("gpt-7")?.contextWindow).toBe(1050000);
    });

    it("returns null for non-GPT models", () => {
      expect(resolveGptFamilyCapabilities("claude-opus-4.7")).toBeNull();
      expect(resolveGptFamilyCapabilities("gemini-2.5-pro")).toBeNull();
      expect(resolveGptFamilyCapabilities("qwen3.5-397b")).toBeNull();
    });
  });

  describe("getCapabilitiesForModel & resolveKnownContextWindow integration", () => {
    it("returns 1,050,000 for Codex GPT-5.6 models through cx/ provider", () => {
      const capsSol = getCapabilitiesForModel("cx", "gpt-5.6-sol");
      expect(capsSol.contextWindow).toBe(1050000);
      expect(capsSol.maxOutput).toBe(128000);
      expect(capsSol.vision).toBe(true);
      expect(capsSol.reasoning).toBe(true);

      const capsTerra = getCapabilitiesForModel("cx", "gpt-5.6-terra");
      expect(capsTerra.contextWindow).toBe(1050000);

      const capsLuna = getCapabilitiesForModel("cx", "gpt-5.6-luna");
      expect(capsLuna.contextWindow).toBe(1050000);

      expect(resolveKnownContextWindow("cx", "gpt-5.6-sol")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.6-terra")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.6-luna")).toBe(1050000);
    });

    it("returns 872,000 for gpt-reserve and codex-auto-review", () => {
      expect(resolveKnownContextWindow("cx", "gpt-reserve")).toBe(872000);
      expect(resolveKnownContextWindow("cx", "codex-auto-review")).toBe(872000);

      const capsReserve = getCapabilitiesForModel("cx", "gpt-reserve");
      expect(capsReserve.contextWindow).toBe(872000);
      expect(capsReserve.vision).toBe(true);
    });

    it("returns 128,000 for gpt-5.3-codex-spark", () => {
      expect(resolveKnownContextWindow("cx", "gpt-5.3-codex-spark")).toBe(128000);
      const caps = getCapabilitiesForModel("cx", "gpt-5.3-codex-spark");
      expect(caps.contextWindow).toBe(128000);
    });

    it("automatically inherits capabilities for -review models", () => {
      // Review variants have parity with base
      expect(resolveKnownContextWindow("cx", "gpt-5.6-sol-review")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.5-review")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.4-review")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.4-mini-review")).toBe(400000);
      expect(resolveKnownContextWindow("cx", "gpt-5.3-codex-spark-review")).toBe(128000);
      expect(resolveKnownContextWindow("cx", "gpt-reserve-review")).toBe(872000);

      const capsReview = getCapabilitiesForModel("cx", "gpt-5.6-sol-review");
      expect(capsReview.contextWindow).toBe(1050000);
      expect(capsReview.vision).toBe(true);
    });

    it("FUTURE MODELS: resolves contextWindow for future unreleased models", () => {
      expect(resolveKnownContextWindow("cx", "gpt-5.7")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.7-review")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-5.8")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-6")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-6-review")).toBe(1050000);
      expect(resolveKnownContextWindow("cx", "gpt-6-mini")).toBe(400000);
      expect(resolveKnownContextWindow("cx", "gpt-6-spark")).toBe(128000);
    });

    it("DYNAMIC SYNC: scoped dynamic sync layers over catalogue", () => {
      // Before sync: 1,050,000
      expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(1050000);

      // Upstream sync reports max_context_window 872,000 for gpt-5.6-sol
      registerDynamicCapabilitiesScoped("codex", "gpt-5.6-sol", { contextWindow: 872000, vision: true });

      // Base model reflects synced value
      expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(872000);
      expect(resolveKnownContextWindow("codex", "gpt-5.6-sol")).toBe(872000);

      // -review model automatically inherits synced value from base
      expect(getCapabilitiesForModel("codex", "gpt-5.6-sol-review").contextWindow).toBe(872000);
      expect(resolveKnownContextWindow("codex", "gpt-5.6-sol-review")).toBe(872000);

      // Other providers remain unaffected (scoped cache isolation)
      expect(getCapabilitiesForModel("openai", "gpt-5.6-sol").contextWindow).toBe(1050000);
    });
  });

  describe("Codex Registry & Pricing Integration", () => {
    it("provides authoritative official pricing for gpt-5.6, 5.5, 5.4, gpt-reserve, and codex-auto-review", async () => {
      const { getPricingForModel } = await import("../../open-sse/providers/pricing.js");

      const p56Sol = getPricingForModel("cx", "gpt-5.6-sol");
      expect(p56Sol?.input).toBe(4.00);
      expect(p56Sol?.output).toBe(20.00);

      const p56Terra = getPricingForModel("cx", "gpt-5.6-terra");
      expect(p56Terra?.input).toBe(2.00);
      expect(p56Terra?.output).toBe(12.00);

      const p56Luna = getPricingForModel("cx", "gpt-5.6-luna");
      expect(p56Luna?.input).toBe(0.20);
      expect(p56Luna?.output).toBe(1.20);

      const p55 = getPricingForModel("cx", "gpt-5.5");
      expect(p55?.input).toBe(7.00);
      expect(p55?.output).toBe(28.00);

      const p54 = getPricingForModel("cx", "gpt-5.4");
      expect(p54?.input).toBe(2.50);
      expect(p54?.output).toBe(15.00);

      const p54Mini = getPricingForModel("cx", "gpt-5.4-mini");
      expect(p54Mini?.input).toBe(0.75);
      expect(p54Mini?.output).toBe(4.50);

      const p54Nano = getPricingForModel("cx", "gpt-5.4-nano");
      expect(p54Nano?.input).toBe(0.20);
      expect(p54Nano?.output).toBe(1.25);

      const pReserve = getPricingForModel("cx", "gpt-reserve");
      expect(pReserve?.input).toBe(6.00);
      expect(pReserve?.output).toBe(24.00);

      const pAuto = getPricingForModel("cx", "codex-auto-review");
      expect(pAuto?.input).toBe(6.00);
      expect(pAuto?.output).toBe(24.00);
    });

    it("verifies codex provider registry models contain GPT-5.6, reserve, and review pairs", async () => {
      const codexConfig = (await import("../../open-sse/providers/registry/codex.js")).default;
      const modelIds = codexConfig.models.map((m) => m.id);

      expect(modelIds).toContain("gpt-5.6-sol");
      expect(modelIds).toContain("gpt-5.6-sol-review");
      expect(modelIds).toContain("gpt-5.6-terra");
      expect(modelIds).toContain("gpt-5.6-terra-review");
      expect(modelIds).toContain("gpt-5.6-luna");
      expect(modelIds).toContain("gpt-5.6-luna-review");
      expect(modelIds).toContain("gpt-reserve");
      expect(modelIds).toContain("gpt-reserve-review");
      expect(modelIds).toContain("codex-auto-review");

      const solReview = codexConfig.models.find((m) => m.id === "gpt-5.6-sol-review");
      expect(solReview?.upstreamModelId).toBe("gpt-5.6-sol");
      expect(solReview?.quotaFamily).toBe("review");

      const autoReview = codexConfig.models.find((m) => m.id === "codex-auto-review");
      expect(autoReview?.quotaFamily).toBe("review");
    });
  });

  describe("Edge cases & regression safety (Grok code review findings)", () => {
    it("distinguishes gpt-4 (text-only) vs gpt-4o (vision/search) vs gpt-4-turbo", () => {
      const gpt4 = resolveGptFamilyCapabilities("gpt-4");
      expect(gpt4?.vision).toBeUndefined(); // text-only (defaults to false)
      expect(gpt4?.contextWindow).toBe(128000);

      const gpt4o = resolveGptFamilyCapabilities("gpt-4o");
      expect(gpt4o?.vision).toBe(true);
      expect(gpt4o?.search).toBe(true);
      expect(gpt4o?.maxOutput).toBe(16384);

      const gpt4Turbo = resolveGptFamilyCapabilities("gpt-4-turbo");
      expect(gpt4Turbo?.vision).toBe(true);
      expect(gpt4Turbo?.search).toBeUndefined(); // not 4o search
    });

    it("ensures codex models are text-only while sol/terra/luna have vision", () => {
      expect(resolveGptFamilyCapabilities("gpt-5.3-codex")?.vision).toBe(false);
      expect(resolveGptFamilyCapabilities("gpt-5.1-codex-mini")?.vision).toBe(false);
      expect(resolveGptFamilyCapabilities("gpt-5.4-codex")?.vision).toBe(false);

      expect(resolveGptFamilyCapabilities("gpt-5.6-sol")?.vision).toBe(true);
      expect(resolveGptFamilyCapabilities("gpt-5.6-terra")?.vision).toBe(true);
      expect(resolveGptFamilyCapabilities("gpt-5.6-luna")?.vision).toBe(true);
      expect(resolveGptFamilyCapabilities("gpt-5.4")?.vision).toBe(true);
    });

    it("does not match 'minimal' as 'mini'", () => {
      const minimal = resolveGptFamilyCapabilities("gpt-5.4-minimal");
      expect(minimal?.contextWindow).toBe(1050000); // not 400000!
    });
  });
});
