import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel, resolveGptFamilyCapabilities } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("GPT-6 Model Capabilities & Pricing", () => {
  describe("Capabilities resolution", () => {
    it("resolves flagship GPT-6 with 1.05M context window, 128k output, vision, and reasoning", () => {
      const caps = getCapabilitiesForModel("openai", "gpt-6");
      expect(caps.contextWindow).toBe(1050000);
      expect(caps.maxOutput).toBe(128000);
      expect(caps.reasoning).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.search).toBe(true);
      expect(caps.thinkingFormat).toBe("openai");
    });

    it("resolves GPT-6 Preview and Pro variants with 1.05M context window", () => {
      const previewCaps = getCapabilitiesForModel("openai", "gpt-6-preview");
      expect(previewCaps.contextWindow).toBe(1050000);
      expect(previewCaps.vision).toBe(true);
      expect(previewCaps.reasoning).toBe(true);

      const proCaps = getCapabilitiesForModel("openai", "gpt-6-pro");
      expect(proCaps.contextWindow).toBe(1050000);
      expect(proCaps.vision).toBe(true);
      expect(proCaps.reasoning).toBe(true);
    });

    it("resolves GPT-6 Codex with vision: false and 1.05M context window", () => {
      const codexCaps = getCapabilitiesForModel("codex", "gpt-6-codex");
      expect(codexCaps.contextWindow).toBe(1050000);
      expect(codexCaps.maxOutput).toBe(128000);
      expect(codexCaps.reasoning).toBe(true);
      expect(codexCaps.vision).toBe(false);
      expect(codexCaps.search).toBe(true);

      const codexMaxCaps = getCapabilitiesForModel("codex", "gpt-6-codex-max");
      expect(codexMaxCaps.contextWindow).toBe(1050000);
      expect(codexMaxCaps.vision).toBe(false);
      expect(codexMaxCaps.reasoning).toBe(true);
    });

    it("resolves GPT-6 Mini with 400k context window and vision", () => {
      const miniCaps = getCapabilitiesForModel("openai", "gpt-6-mini");
      expect(miniCaps.contextWindow).toBe(400000);
      expect(miniCaps.maxOutput).toBe(128000);
      expect(miniCaps.reasoning).toBe(true);
      expect(miniCaps.vision).toBe(true);
    });

    it("resolves GPT-6 Nano with 400k context window and vision", () => {
      const nanoCaps = getCapabilitiesForModel("openai", "gpt-6-nano");
      expect(nanoCaps.contextWindow).toBe(400000);
      expect(nanoCaps.maxOutput).toBe(128000);
      expect(nanoCaps.reasoning).toBe(true);
      expect(nanoCaps.vision).toBe(true);
    });

    it("resolves future GPT-6.1+ dynamically via resolveGptFamilyCapabilities", () => {
      const gpt61Caps = getCapabilitiesForModel("openai", "gpt-6.1");
      expect(gpt61Caps.contextWindow).toBe(1050000);
      expect(gpt61Caps.reasoning).toBe(true);
      expect(gpt61Caps.vision).toBe(true);

      const gpt61MiniCaps = getCapabilitiesForModel("openai", "gpt-6.1-mini");
      expect(gpt61MiniCaps.contextWindow).toBe(400000);
    });
  });

  describe("GitHub Copilot model rules & boundary verification", () => {
    it("requiresMaxCompletionTokens respects word boundaries and supports o1/o3/o4 and gpt-5/6", () => {
      const gh = new GithubExecutor();
      expect(gh.requiresMaxCompletionTokens("gpt-5")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("gpt-5.4")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("gpt-6")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("gpt-6-mini")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("o1")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("o3-mini")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("o4-preview")).toBe(true);

      // Must not match false positives without boundary
      expect(gh.requiresMaxCompletionTokens("gpt-50")).toBe(false);
      expect(gh.requiresMaxCompletionTokens("not-gpt-6foo")).toBe(false);
      expect(gh.requiresMaxCompletionTokens("o2")).toBe(false);
    });

    it("stripUnsupportedParams drops temperature for GPT-5.4+, GPT-6+, GPT-7+ and keeps for older", () => {
      const bodyModern = { temperature: 0.7, max_tokens: 1000 };
      stripUnsupportedParams("github", "gpt-5.4", bodyModern);
      expect(bodyModern.temperature).toBeUndefined();

      const body510 = { temperature: 0.7 };
      stripUnsupportedParams("github", "gpt-5.10", body510);
      expect(body510.temperature).toBeUndefined();

      const body6 = { temperature: 0.7 };
      stripUnsupportedParams("github", "gpt-6", body6);
      expect(body6.temperature).toBeUndefined();

      const body6Mini = { temperature: 0.7 };
      stripUnsupportedParams("github", "gpt-6-mini", body6Mini);
      expect(body6Mini.temperature).toBeUndefined();

      const bodyOlder = { temperature: 0.7 };
      stripUnsupportedParams("github", "gpt-5.3", bodyOlder);
      expect(bodyOlder.temperature).toBe(0.7);
    });
  });

  describe("Pricing resolution & overload boundary", () => {
    it("resolves canonical GPT-6 rates", () => {
      const pricing = getPricingForModel("gpt-6");
      expect(pricing.input).toBe(5.00);
      expect(pricing.output).toBe(25.00);
      expect(pricing.cached).toBe(0.50);
      expect(pricing.reasoning).toBe(25.00);
    });

    it("resolves canonical GPT-6 Mini rates", () => {
      const pricing = getPricingForModel("gpt-6-mini");
      expect(pricing.input).toBe(1.00);
      expect(pricing.output).toBe(5.00);
      expect(pricing.cached).toBe(0.10);
    });

    it("resolves canonical GPT-6 Nano rates", () => {
      const pricing = getPricingForModel("gpt-6-nano");
      expect(pricing.input).toBe(0.25);
      expect(pricing.output).toBe(1.50);
      expect(pricing.cached).toBe(0.025);
    });

    it("resolves canonical GPT-6 Pro and Codex Max rates", () => {
      const proPricing = getPricingForModel("gpt-6-pro");
      expect(proPricing.input).toBe(10.00);
      expect(proPricing.output).toBe(50.00);

      const codexMaxPricing = getPricingForModel("gpt-6-codex-max");
      expect(codexMaxPricing.input).toBe(10.00);
      expect(codexMaxPricing.output).toBe(50.00);
    });

    it("resolves TokenRouter provider-specific GPT-6 rates", () => {
      const pricing = getPricingForModel("tokenrouter", "openai/gpt-6");
      expect(pricing.input).toBe(2.50);
      expect(pricing.output).toBe(15.0);
      expect(pricing.cached).toBe(0.25);
    });

    it("resolves pattern-based GPT-6 fallback for cx/gpt-6", () => {
      const pricing = getPricingForModel("codex", "cx/gpt-6");
      expect(pricing.input).toBe(5.00);
      expect(pricing.output).toBe(25.00);
    });

    it("does not match gpt-60 into gpt-6 pattern pricing", () => {
      const pricing = getPricingForModel("codex", "cx/gpt-60");
      expect(pricing).toBeNull();
    });

    it("handles overload strictly: 2-arg call with undefined model returns null", () => {
      expect(getPricingForModel("openai", undefined)).toBeNull();
      expect(getPricingForModel("openai", "")).toBeNull();
      expect(getPricingForModel("gpt-6")).toBeDefined();
    });
  });
});
