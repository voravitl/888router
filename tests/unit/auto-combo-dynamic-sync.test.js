import { describe, it, expect } from "vitest";
import {
  registerDynamicCapabilitiesScoped,
  getDynamicCapabilitiesSnapshot,
  getCapabilitiesForModel,
  resolveKnownContextWindow,
  registerDynamicCapabilities,
} from "../../open-sse/providers/capabilities.js";
import { resolveVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("auto-combo dynamic-synced model union", () => {
  it("bleed guard: same bare id on two providers resolves independently", () => {
    const tag = `bleed-${Date.now()}-${Math.random()}`;
    registerDynamicCapabilitiesScoped("xai", tag, {
      vision: true,
      contextWindow: 300000,
    });
    registerDynamicCapabilitiesScoped("anthropic", tag, {
      vision: false,
      contextWindow: 200000,
    });

    const xaiCaps = getCapabilitiesForModel("xai", tag);
    const anthropicCaps = getCapabilitiesForModel("anthropic", tag);
    expect(xaiCaps.contextWindow).toBe(300000);
    expect(xaiCaps.vision).toBe(true);
    expect(anthropicCaps.contextWindow).toBe(200000);
    expect(anthropicCaps.vision).toBe(false);
  });

  it("scoped + bare layering: bare fields survive when scoped is partial", () => {
    const tag = `layer-${Date.now()}-${Math.random()}`;
    registerDynamicCapabilities(tag, {
      contextWindow: 128000,
      vision: true,
    });
    registerDynamicCapabilitiesScoped("openai", tag, {
      vision: false,
    });

    const caps = getCapabilitiesForModel("openai", tag);
    expect(caps.contextWindow).toBe(128000); // bare kept
    expect(caps.vision).toBe(false); // scoped won
  });

  it("invalid contextWindow is rejected (sanity bound)", () => {
    const tag = `sanity-${Date.now()}-${Math.random()}`;
    const accepted = registerDynamicCapabilitiesScoped("anthropic", tag, {
      contextWindow: 100_000_000, // implausible (>10M)
    });
    expect(accepted).toBe(false);
  });

  it("non-active provider excluded from combo candidate union", async () => {
    const tag = `nonact-${Date.now()}-${Math.random()}`;
    registerDynamicCapabilitiesScoped("removed-provider-x", tag, {
      vision: true,
      reasoning: true,
      contextWindow: 1000000,
    });

    const models =
      (await resolveVirtualAutoCombo("auto/coding:pro"))?.models || [];
    expect(models).not.toContain(`removed-provider-x/${tag}`);
    expect(PROVIDERS["removed-provider-x"]).toBeUndefined();
  });

  it("free tier filter rejects paid model on unknown provider", async () => {
    const tag = `paid-${Date.now()}-${Math.random()}`;
    registerDynamicCapabilitiesScoped("paid-only-provider-z", tag, {
      vision: true,
      reasoning: true,
      contextWindow: 200000,
    });

    const models =
      (await resolveVirtualAutoCombo("auto/best-free"))?.models || [];
    expect(models).not.toContain(`paid-only-provider-z/${tag}`);
  });

  it("clone guard: writer returns false does not mutate the cache", () => {
    const tag = `clone-${Date.now()}-${Math.random()}`;
    const accepted = registerDynamicCapabilitiesScoped("ollama", tag, {
      vision: true,
      reasoning: true,
      contextWindow: 1000000,
    });
    expect(accepted).toBe(true);

    // The capability resolver returns a layered view ({...bareDyn, ...scopedDyn})
    // per resolveKnownContextWindow / getCapabilitiesForModel. So a downstream
    // mutation of the returned object can't reach the cache because the
    // spread creates a fresh object every call. This test pins that contract.
    const caps = getCapabilitiesForModel("ollama", tag);
    caps.contextWindow = 999999;
    const liveCaps = getCapabilitiesForModel("ollama", tag);
    expect(liveCaps.contextWindow).toBe(1000000);
  });

  it("scoped + bare layering in resolveKnownContextWindow too", () => {
    const tag = `ctx-${Date.now()}-${Math.random()}`;
    registerDynamicCapabilities(tag, { contextWindow: 64000 });
    registerDynamicCapabilitiesScoped("anthropic", tag, {
      vision: false,
    });
    expect(resolveKnownContextWindow("anthropic", tag)).toBe(64000);
  });

  it("registerDynamicCapabilitiesScoped returns false on invalid input", () => {
    expect(
      registerDynamicCapabilitiesScoped("", "model", { contextWindow: 100 })
    ).toBe(false);
    expect(
      registerDynamicCapabilitiesScoped("xai", "", { contextWindow: 100 })
    ).toBe(false);
    expect(
      registerDynamicCapabilitiesScoped("xai", "model", null)
    ).toBe(false);
    expect(
      registerDynamicCapabilitiesScoped("xai", "model", "not an object")
    ).toBe(false);
  });
});