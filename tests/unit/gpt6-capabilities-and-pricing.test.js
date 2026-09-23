import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { GithubExecutor } from "../../open-sse/executors/github.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

// Official upstream Codex slugs come from ~/.codex/models_cache.json:
// gpt-6-astra, gpt-reserve, gpt-5.6-sol/terra/luna, gpt-5.5, codex-auto-review.
// Bare "gpt-6", "gpt-6-mini", "gpt-6-preview", etc. are invented slugs that the
// upstream rejects with "not supported when using Codex with a ChatGPT account".

describe("GPT-6 Model Capabilities & Pricing", () => {
  describe("Capabilities resolution", () => {
    it("resolves official GPT-6 Astra with 1.05M context window, 128k output, vision, and reasoning", () => {
      const caps = getCapabilitiesForModel("openai", "gpt-6-astra");
      expect(caps.contextWindow).toBe(1050000);
      expect(caps.maxOutput).toBe(128000);
      expect(caps.reasoning).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.search).toBe(true);
      expect(caps.thinkingFormat).toBe("openai");
    });

    it("resolves GPT-6 Astra for the codex provider as well", () => {
      const codexCaps = getCapabilitiesForModel("codex", "gpt-6-astra");
      expect(codexCaps.contextWindow).toBe(1050000);
      expect(codexCaps.maxOutput).toBe(128000);
      expect(codexCaps.reasoning).toBe(true);
    });

    it("resolves GPT-6 Sol and Luna for the codex provider", () => {
      const solCaps = getCapabilitiesForModel("codex", "gpt-6-sol");
      expect(solCaps.contextWindow).toBe(1050000);
      expect(solCaps.reasoning).toBe(true);

      const lunaCaps = getCapabilitiesForModel("codex", "gpt-6-luna");
      expect(lunaCaps.contextWindow).toBe(1050000);
      expect(lunaCaps.reasoning).toBe(true);
    });

    it("resolves future GPT-6.1+ dynamically via resolveGptFamilyCapabilities", () => {
      const gpt61Caps = getCapabilitiesForModel("openai", "gpt-6.1");
      expect(gpt61Caps.contextWindow).toBe(1050000);
      expect(gpt61Caps.reasoning).toBe(true);
      expect(gpt61Caps.vision).toBe(true);
    });
  });

  describe("GitHub Copilot model rules & boundary verification", () => {
    it("requiresMaxCompletionTokens respects word boundaries and supports o1/o3/o4 and gpt-5/6", () => {
      const gh = new GithubExecutor();
      expect(gh.requiresMaxCompletionTokens("gpt-5")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("gpt-5.4")).toBe(true);
      expect(gh.requiresMaxCompletionTokens("gpt-6-astra")).toBe(true);
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
      stripUnsupportedParams("github", "gpt-6-astra", body6);
      expect(body6.temperature).toBeUndefined();

      const bodyOlder = { temperature: 0.7 };
      stripUnsupportedParams("github", "gpt-5.3", bodyOlder);
      expect(bodyOlder.temperature).toBe(0.7);
    });
  });

  describe("Pricing resolution & overload boundary", () => {
    it("resolves canonical GPT-6 Astra rates", () => {
      const pricing = getPricingForModel("gpt-6-astra");
      expect(pricing.input).toBe(5.00);
      expect(pricing.output).toBe(25.00);
      expect(pricing.cached).toBe(0.50);
      expect(pricing.reasoning).toBe(25.00);
    });

    it("resolves canonical GPT-6 Sol and Luna rates", () => {
      const solPricing = getPricingForModel("gpt-6-sol");
      expect(solPricing.input).toBe(4.00);
      expect(solPricing.output).toBe(20.00);
      expect(solPricing.cached).toBe(0.40);

      const lunaPricing = getPricingForModel("gpt-6-luna");
      expect(lunaPricing.input).toBe(0.25);
      expect(lunaPricing.output).toBe(1.25);
      expect(lunaPricing.cached).toBe(0.025);
    });

    it("resolves TokenRouter provider-specific GPT-6 Astra rates", () => {
      const pricing = getPricingForModel("tokenrouter", "openai/gpt-6-astra");
      expect(pricing.input).toBe(2.50);
      expect(pricing.output).toBe(15.0);
      expect(pricing.cached).toBe(0.25);
    });

    it("resolves pattern-based GPT-6 fallback for cx/gpt-6-astra", () => {
      const pricing = getPricingForModel("codex", "cx/gpt-6-astra");
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
      expect(getPricingForModel("gpt-6-astra")).toBeDefined();
    });
  });
});
