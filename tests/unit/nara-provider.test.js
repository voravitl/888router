import { describe, expect, it } from "vitest";
import { isFreeCandidate } from "../../open-sse/services/autoCombo/virtualFactory.js";

// Evidence: public /pricing page crawled 2026-09-13 — 55 models, 10 free surfaces
// with 7M/day recurring pool on free tier.
// GET /v1/models requires an API key, so the registry seed
// below mirrors the public page and the generic openai modelsFetcher syncs
// the live list after a key is added.
describe("nara provider registration", () => {
  it("registry entry exposes seed models + openai fetcher", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    expect(entry).toBeTruthy();
    expect(entry.models.length).toBe(55);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://router.bynara.id/v1/models",
      type: "openai",
    });
    expect(entry.transport.baseUrl).toBe("https://router.bynara.id/v1/chat/completions");
    // Verify free surfaces present in seed
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

  it("free surfaces pass the free-tier gate (paid siblings do not)", () => {
    for (const id of [
      "tencent-hy3-free",
      "deepseek-v4.1-flash-free",
      "glm-5.3-free",
      "mimo-v2.5-free",
      "muse-spark-1.3-contributor-free",
      "qwen3.8-flash-free",
      "ling-3.0-flash-fin-free",
    ]) {
      expect(isFreeCandidate("nara", id), id).toBe(true);
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

  it("seed contract is exact (55 surfaces, no drift)", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    const ids = entry.models.map((m) => (typeof m === "string" ? m : m.id));
    expect(ids).toEqual([
      "agnes-2.5-flash",
      "agnes-video-v2.0",
      "claude-fable-5",
      "claude-fable-5.1",
      "claude-opus-4.7",
      "claude-opus-4.7-promo",
      "claude-opus-4.8",
      "claude-opus-5",
      "claude-opus-5-promo",
      "claude-sonnet-5",
      "deepseek-v4-flash-alibaba",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro-alibaba",
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-free",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gemini-3.8-flash-high",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-free",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "grok-4.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "laguna-s-2.1",
      "ling-3.0-flash-fin-free",
      "mimo-v2.5",
      "mimo-v2.5-free",
      "mimo-v2.5-pro",
      "minimax-m3",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.3-contributor-free",
      "qwen3.7-flash",
      "qwen3.8-2.4t",
      "qwen3.8-27b",
      "qwen3.8-flash",
      "qwen3.8-flash-free",
      "qwen3.8-max",
      "qwen3.8-max-alibaba",
      "stepfun-3.7-flash",
      "tencent-hy3-free",
      "tencent-hy4-preview",
      "agnes-image-2.0-flash",
      "agnes-image-2.1-flash",
      "grok-imagine",
      "nano-banana-pro",
    ]);
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
