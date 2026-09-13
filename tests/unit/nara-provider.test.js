import { describe, expect, it } from "vitest";
import { isFreeCandidate } from "../../open-sse/services/autoCombo/virtualFactory.js";

// Evidence: public /pricing page crawled 2026-09-13 — 50 chat models + 3 legacy aliases,
// 10 free surfaces with 7M/day recurring pool on free tier.
// GET /v1/models requires an API key, so the registry seed
// below mirrors the public page and the generic openai modelsFetcher syncs
// the live list after a key is added.
describe("nara provider registration", () => {
  it("registry entry exposes seed models + openai fetcher", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    expect(entry).toBeTruthy();
    expect(entry.models.length).toBeGreaterThanOrEqual(50);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://router.bynara.id/v1/models",
      type: "openai",
    });
    expect(entry.transport.baseUrl).toBe("https://router.bynara.id/v1/chat/completions");
    // Verify all 10 free surfaces present in seed
    for (const id of [
      "agnes-2.5-flash",
      "laguna-s-2.1",
      "ling-3.0-flash-fin-free",
      "stepfun-3.7-flash",
      "tencent-hy3-free",
      "deepseek-v4.1-flash-free",
      "glm-5.3-free",
      "mimo-v2.5-free",
      "muse-spark-1.3-contributor-free",
      "qwen3.8-flash-free",
    ]) {
      expect(entry.models.some((m) => (typeof m === "string" ? m : m.id) === id), id).toBe(true);
    }
  });

  it("all 10 free catalog surfaces pass the free-tier gate (paid siblings do not)", async () => {
    const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.js");
    const freeIds = FREE_MODEL_BUDGETS.filter((f) => f.provider === "nara").map((f) => f.modelId);
    expect(freeIds.length).toBe(10);
    for (const id of freeIds) {
      expect(isFreeCandidate("nara", id), `nara/${id} must pass isFreeCandidate`).toBe(true);
    }
    for (const id of ["deepseek-v4.1-flash", "mimo-v2.5", "glm-5.3", "claude-opus-5"]) {
      expect(isFreeCandidate("nara", id), id).toBe(false);
    }
  });

  it("free catalog rows resolve against the registry seed", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.js");
    const rows = FREE_MODEL_BUDGETS.filter((f) => f.provider === "nara");
    expect(rows.length).toBe(10);
    for (const row of rows) {
      const reg = (PROVIDERS["nara"]?.models || []).find((x) =>
        typeof x === "string" ? x === row.modelId : x?.id === row.modelId,
      );
      expect(reg, `nara/${row.modelId} in registry`).toBeTruthy();
    }
  });

  it("legacy compatibility models are retained", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    const ids = entry.models.map((m) => (typeof m === "string" ? m : m.id));
    expect(ids).toContain("tencent-hy3");
    expect(ids).toContain("mistral-large");
    expect(ids).toContain("mistral-medium-3-5");
  });

  it("short aliases resolve via ALIAS_TO_ID + getProviderByAlias", async () => {
    const { ALIAS_TO_ID, getProviderByAlias } = await import("../../src/shared/constants/providers.js");
    expect(ALIAS_TO_ID["nara"]).toBe("nara");
    expect(ALIAS_TO_ID["nararouter"]).toBe("nara");
    expect(ALIAS_TO_ID["bynara"]).toBe("nara");
    expect(ALIAS_TO_ID["by-nara"]).toBe("nara");
    expect(getProviderByAlias("nararouter")?.id).toBe("nara");
    expect(getProviderByAlias("bynara")?.id).toBe("nara");
    expect(getProviderByAlias("by-nara")?.id).toBe("nara");
  });

  it("free members appear in auto/best-free candidates", async () => {
    const { resolveVirtualAutoCombo } = await import("../../open-sse/services/autoCombo/virtualFactory.js");
    const combo = resolveVirtualAutoCombo("auto/best-free");
    expect(combo).not.toBeNull();
    expect(combo.models).toContain("nara/tencent-hy3-free");
    expect(combo.models).toContain("nara/deepseek-v4.1-flash-free");
    expect(combo.models).toContain("nara/agnes-2.5-flash");
    expect(combo.models).toContain("nara/laguna-s-2.1");
    expect(combo.models).toContain("nara/stepfun-3.7-flash");
  });

  it("quota exhaustion falls back via the shared combo executor (402/429)", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
    expect(checkFallbackError(402, "payment required").shouldFallback).toBe(true);
    expect(checkFallbackError(429, "rate limited").shouldFallback).toBe(true);
    expect(checkFallbackError(404, "not found").modelError).toBe(true);
  });

  it("keyed gateway needs a connection: no virtual injection for nara", async () => {
    const { AI_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    const def = AI_PROVIDERS["nara"];
    expect(def, "nara registered in AI_PROVIDERS").toBeDefined();
    expect(def.noAuth, "nara is keyed (no virtual injection)").toBeFalsy();
  });
});
