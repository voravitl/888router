import { describe, expect, it } from "vitest";
import { isFreeCandidate } from "../../open-sse/services/autoCombo/virtualFactory.js";

// Evidence: public /models page scraped 2026-09-11 — 18 paid + 3 free
// surfaces with priceIn/priceOut/isFree flags
// (freeRows: deepseek-v4.1-flash:free, deepseek-v4-flash:free,
// mimo-v2.5:free; all price 0/0, isFree:true).
// GET /v1/models requires an API key (401 without), so the registry seed
// below mirrors the public page and the generic openai modelsFetcher syncs
// the live list after a key is added.
describe("tokenharbor provider registration", () => {
  it("registry entry exposes seed models + openai fetcher", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "tokenharbor");
    expect(entry).toBeTruthy();
    expect(entry.models.length).toBeGreaterThanOrEqual(21);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://tokenharbor.ai/v1/models",
      type: "openai",
    });
    expect(entry.transport.baseUrl).toBe("https://tokenharbor.ai/v1/chat/completions");
    // All 3 free surfaces present in seed.
    for (const id of ["deepseek-v4.1-flash:free", "deepseek-v4-flash:free", "mimo-v2.5:free"]) {
      expect(entry.models.some((m) => (typeof m === "string" ? m : m.id) === id), id).toBe(true);
    }
  });

  it("free surfaces pass the free-tier gate (paid siblings do not)", () => {
    for (const id of ["deepseek-v4.1-flash:free", "deepseek-v4-flash:free", "mimo-v2.5:free"]) {
      expect(isFreeCandidate("tokenharbor", id), id).toBe(true);
    }
    for (const id of ["deepseek-v4.1-flash", "mimo-v2.5", "glm-5.3"]) {
      expect(isFreeCandidate("tokenharbor", id), id).toBe(false);
    }
  });

  it("free catalog rows resolve against the registry seed", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.js");
    const rows = FREE_MODEL_BUDGETS.filter((f) => f.provider === "tokenharbor");
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const reg = (PROVIDERS["tokenharbor"]?.models || []).find((x) =>
        typeof x === "string" ? x === row.modelId : x?.id === row.modelId,
      );
      expect(reg, `tokenharbor/${row.modelId} in registry`).toBeTruthy();
    }
  });

  it("seed contract is exact (21 surfaces, no drift)", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "tokenharbor");
    const ids = entry.models.map((m) => (typeof m === "string" ? m : m.id));
    // Exact list — a seed add/remove is a deliberate catalog change, not
    // silent drift. Update this list + evidence comment when the public
    // /models page changes.
    expect(ids).toEqual([
      "claude-fable-5.1", "gpt-6-astra", "claude-opus-5", "gpt-5.6-sol",
      "glm-5.3", "grok-4.6", "kimi-k3", "gpt-5.6-terra", "qwen3.8-max",
      "deepseek-v4.1-flash", "glm-5.3-flash", "gemini-3.8-flash",
      "qwen3.8-flash", "gpt-5.6-luna", "deepseek-v4-flash", "qwen3.8-27b",
      "mimo-v2.5-pro", "mimo-v2.5",
      "deepseek-v4.1-flash:free", "deepseek-v4-flash:free", "mimo-v2.5:free",
    ]);
  });

  it("short aliases resolve via ALIAS_TO_ID + getProviderByAlias", async () => {
    const { ALIAS_TO_ID, getProviderByAlias } = await import("../../src/shared/constants/providers.js");
    expect(ALIAS_TO_ID["th"]).toBe("tokenharbor");
    expect(ALIAS_TO_ID["token-harbor"]).toBe("tokenharbor");
    expect(getProviderByAlias("th")?.id).toBe("tokenharbor");
    expect(getProviderByAlias("token-harbor")?.id).toBe("tokenharbor");
    // No silent collision: th is owned by tokenharbor only.
    expect(ALIAS_TO_ID["tokenharbor"]).toBe("tokenharbor");
  });

  it("free members appear in auto/best-free candidates", async () => {
    const { resolveVirtualAutoCombo } = await import("../../open-sse/services/autoCombo/virtualFactory.js");
    const combo = resolveVirtualAutoCombo("auto/best-free");
    expect(combo).not.toBeNull();
    expect(combo.models).toContain("tokenharbor/deepseek-v4-flash:free");
    expect(combo.models).toContain("tokenharbor/mimo-v2.5:free");
  });

  it("quota exhaustion falls back via the shared combo executor (402/429)", async () => {
    // Unknown-quota free rows are safe to route because the SHARED executor
    // path (not provider code) handles exhaustion: 402 → long cooldown +
    // next model, 429 → exponential backoff + next model (errorConfig.js
    // status rules, exercised by the combo suite). No provider-specific
    // fallback logic needed or added here.
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
    expect(checkFallbackError(402, "payment required").shouldFallback).toBe(true);
    expect(checkFallbackError(429, "rate limited").shouldFallback).toBe(true);
    // 404 (unknown/stale id) skips to the next model without cycling accounts.
    expect(checkFallbackError(404, "not found").modelError).toBe(true);
  });

  it("free gate is substring-based by design (pins current boundary)", async () => {
    // isFreeCandidate matches any id containing "free" (the :free family
    // convention shared by all providers) — NOT a strict :free suffix. The
    // registry seed + live catalog remain the real allowlist; the gate only
    // decides free-tier candidacy. These assertions pin the boundary so a
    // future gate tightening is deliberate, not silent.
    const { isFreeCandidate } = await import("../../open-sse/services/autoCombo/virtualFactory.js");
    expect(isFreeCandidate("tokenharbor", "deepseek-v4-flash:free-suffix")).toBe(true); // contains "free"
    expect(isFreeCandidate("tokenharbor", "deepseek-v4-flash")).toBe(false);
    expect(isFreeCandidate("tokenharbor", "unknown:free")).toBe(true); // suffix-only, registry-gated elsewhere
  });

  it("keyed gateway needs a connection: no virtual injection for tokenharbor", async () => {
    // /v1/models only lists keyed-gateway providers (tokenharbor, bai,
    // tokenrouter, ...) when a real connection row exists — unlike
    // noAuth+hasFree providers (aipass, opencode) which get a virtual
    // connection. A fresh install with zero connections must not route
    // auto/best-free into a 401. Strict assertions: the entry must EXIST
    // (a missing registration must fail, not pass vacuously).
    const { AI_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    const def = AI_PROVIDERS["tokenharbor"];
    expect(def, "tokenharbor registered in AI_PROVIDERS").toBeDefined();
    expect(def.noAuth, "tokenharbor is keyed (no virtual injection)").toBeFalsy();
    // Same convention as bai/tokenrouter: keyed gateways are NOT noAuth.
    const { AI_PROVIDERS: p2 } = await import("../../src/shared/constants/providers.js");
    expect(p2["bai"]?.noAuth ?? false).toBe(false);
  });
});
