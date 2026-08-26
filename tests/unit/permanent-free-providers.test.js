import { describe, it, expect } from "vitest";
import { PROVIDERS } from "open-sse/config/providers.js";
import { isPublicModelsProvider } from "@/shared/constants/providers.js";
import { FREE_MODEL_BUDGETS } from "open-sse/config/freeModelCatalog.data.js";

describe("Permanent Free Providers & Model Sync", () => {
  const newFreeProviders = [
    "duckduckgo-web",
    "felo-web",
    "cheaperinference",
    "freebuff",
    "zenmux-free",
  ];

  it("should have all 5 new permanent free providers registered in PROVIDERS", () => {
    for (const pid of newFreeProviders) {
      expect(PROVIDERS[pid]).toBeDefined();
      expect(PROVIDERS[pid].models.length).toBeGreaterThan(0);
      expect(PROVIDERS[pid].hasFree).toBe(true);
    }
  });

  it("should identify keyless providers correctly", () => {
    expect(PROVIDERS["duckduckgo-web"].authType).toBe("none");
    expect(PROVIDERS["felo-web"].authType).toBe("none");
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
