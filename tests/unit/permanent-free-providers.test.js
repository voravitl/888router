import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { isPublicModelsProvider } from "@/shared/constants/providers.js";
import { FREE_MODEL_BUDGETS } from "open-sse/config/freeModelCatalog.data.js";

describe("Permanent Free Providers & Model Sync", () => {
  const newFreeProviders = [
    "felo-web",
    "cheaperinference",
    "freebuff",
    "zenmux-free",
  ];

  it("should have remaining permanent free providers registered in PROVIDERS", () => {
    for (const pid of newFreeProviders) {
      expect(PROVIDERS[pid]).toBeDefined();
      expect(PROVIDERS[pid].models.length).toBeGreaterThan(0);
      expect(PROVIDERS[pid].hasFree).toBe(true);
    }
  });

  it("does not register the removed duckduckgo-web provider", () => {
    expect(PROVIDERS["duckduckgo-web"]).toBeUndefined();
  });

  it("should identify keyless providers correctly", () => {
    // felo-web: moved to openapi.felo.ai LLM API — apikey, not keyless
    expect(PROVIDERS["felo-web"].authType).toBe("apikey");
  });

  it("should use chat-compatible transports (no search/turnstile endpoints)", () => {
    // felo /search/threads needs a turnstile token + query-shaped body; zenmux
    // anthropic endpoint must declare the claude format so the translator runs.
    expect(PROVIDERS["felo-web"].baseUrl).toContain("/chat/completions");
    expect(PROVIDERS["zenmux-free"].format).toBe("claude");
  });

  it("should recognize public model listing for all free gateways and agentrouter", () => {
    for (const pid of newFreeProviders) {
      expect(isPublicModelsProvider(pid)).toBe(true);
    }
    expect(isPublicModelsProvider("agentrouter")).toBe(true);
    expect(isPublicModelsProvider("api-airforce")).toBe(true);
  });

  it("should have catalog entries in freeModelCatalog for all new free providers", () => {
    const catalogProviders = new Set(FREE_MODEL_BUDGETS.map((m) => m.provider));
    for (const pid of newFreeProviders) {
      expect(catalogProviders.has(pid)).toBe(true);
    }
  });
});
