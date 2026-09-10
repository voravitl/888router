import { describe, it, expect } from "vitest";
import { parseAutoSuffix } from "../../open-sse/services/autoCombo/suffixComposition.js";
import {
  resolveVirtualAutoCombo,
  isFreeCandidate,
  isCodingModelId,
} from "../../open-sse/services/autoCombo/virtualFactory.js";
import { getRotatedModels } from "../../open-sse/services/combo.js";

describe("Auto-Combo 2.0 & Suffix Composition Parity", () => {
  it("parses suffix expressions into category and tier correctly", () => {
    expect(parseAutoSuffix("coding:fast")).toEqual({ valid: true, category: "coding", tier: "fast" });
    expect(parseAutoSuffix("coding:free")).toEqual({ valid: true, category: "coding", tier: "free" });
    expect(parseAutoSuffix("multimodal:free")).toEqual({ valid: true, category: "multimodal", tier: "free" });
    expect(parseAutoSuffix("best-coding")).toEqual({ valid: true, category: "coding", tier: "pro" });
    expect(parseAutoSuffix("best-free")).toEqual({ valid: true, category: "chat", tier: "free" });
    expect(parseAutoSuffix("best-free-1m")).toEqual({ valid: true, category: "chat", tier: "free", contextMin: 1000000 });
    expect(parseAutoSuffix("free-1m")).toEqual({ valid: true, category: "chat", tier: "free", contextMin: 1000000 });
  });

  it("dynamically materializes virtual auto combo candidates", () => {
    const freeCombo = resolveVirtualAutoCombo("auto/best-free");
    expect(freeCombo).not.toBeNull();
    expect(freeCombo.name).toBe("auto/best-free");
    expect(freeCombo.strategy).toBe("reset-aware");
    expect(freeCombo.models.length).toBeGreaterThan(0);

    const free1mCombo = resolveVirtualAutoCombo("auto/best-free-1m");
    expect(free1mCombo).not.toBeNull();
    expect(free1mCombo.name).toBe("auto/best-free-1m");
    expect(free1mCombo.strategy).toBe("reset-aware");
    expect(free1mCombo.models.length).toBeGreaterThan(0);

    const codingCombo = resolveVirtualAutoCombo("auto/best-coding");
    expect(codingCombo).not.toBeNull();
    expect(codingCombo.name).toBe("auto/best-coding");
    expect(codingCombo.models.length).toBeGreaterThan(0);
  });

  it("free-tier combos contain only free models (no paid leak)", () => {
    for (const name of ["auto/best-free", "auto/best-free-1m", "auto/free-1m"]) {
      const combo = resolveVirtualAutoCombo(name);
      expect(combo).not.toBeNull();
      expect(combo.models.length).toBeGreaterThan(0);
      const leak = combo.models.filter((m) => {
        const i = m.indexOf("/");
        return !isFreeCandidate(m.slice(0, i), m.slice(i + 1));
      });
      expect(leak).toEqual([]);
    }
    // Explicit registry fixtures (not classifier-oracle): antigravity has no
    // free-catalog rows so its paid gemini models must be excluded, while a
    // known free registry model must be present.
    const bestFree = resolveVirtualAutoCombo("auto/best-free");
    expect(bestFree.models).not.toContain("antigravity/gemini-3.8-flash-high");
    expect(bestFree.models).toContain("chatgpt-web/gpt-5.6-luna-free");
    // No duplicate members: gemini-2.5-flash(-lite) exist twice in the gemini
    // registry (chat + stt kinds) but must appear at most once.
    for (const name of ["auto/best-free", "auto/best-free-1m"]) {
      const models = resolveVirtualAutoCombo(name).models;
      expect(new Set(models).size).toBe(models.length);
    }
    // No non-chat modality members: embedding/image/stt entries must not leak
    // into a chat combo (they fail at the provider on text prompts).
    expect(bestFree.models).not.toContain(
      "openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free"
    );
    expect(bestFree.models).not.toContain("aipass/gpt-image-2");
  });

  it("coding category filters to code-family models", () => {
    const coding = resolveVirtualAutoCombo("auto/best-coding");
    expect(coding).not.toBeNull();
    expect(coding.models.length).toBeGreaterThan(0);
    // Every member must match the code-family gate (no chat-generality leak).
    const nonCoding = coding.models.filter(
      (m) => !isCodingModelId(m.slice(m.indexOf("/") + 1))
    );
    expect(nonCoding).toEqual([]);
    // Spot checks: a known code-specialist stays, a known chat-only goes.
    // (deepseek-chat is a generalist — correctly excluded under narrow policy.)
    expect(coding.models).toContain("tokenrouter/qwen/qwen3-coder-next");
    expect(coding.models).not.toContain("antigravity/gemini-3.8-flash-high");
    expect(coding.models).not.toContain("deepseek/deepseek-chat");
    // Negative unit checks on the classifier itself: narrow policy means
    // generalist chat models are EXCLUDED even if code-capable — `coding`
    // means code-specialist, not "any strong chat model".
    expect(isCodingModelId("some-encoder-model")).toBe(false);
    expect(isCodingModelId("my-codec-helper")).toBe(false);
    expect(isCodingModelId("sonnetized-chat")).toBe(false);
    expect(isCodingModelId("gemini-2.5-flash")).toBe(false);
    expect(isCodingModelId("qwen3.5-plus")).toBe(false);
    expect(isCodingModelId("deepseek-v4-pro")).toBe(false);
    expect(isCodingModelId("vendor-code:free")).toBe(true);
    expect(isCodingModelId("vendor/coding:free")).toBe(true);
    expect(isCodingModelId("qwen3-coder-next")).toBe(true);
    expect(isCodingModelId("gpt-5.3-codex")).toBe(true);
    expect(isCodingModelId("kimi-k2.7-code")).toBe(true);
    expect(isCodingModelId("claude-sonnet-4-20250514")).toBe(true);
  });

  it("cheap tier folds into free-only (no paid models)", () => {
    for (const name of ["auto/cheap", "auto/coding:cheap"]) {
      const combo = resolveVirtualAutoCombo(name);
      expect(combo).not.toBeNull();
      expect(combo.models.length).toBeGreaterThan(0);
      const paid = combo.models.filter((m) => {
        const i = m.indexOf("/");
        return !isFreeCandidate(m.slice(0, i), m.slice(i + 1));
      });
      expect(paid).toEqual([]);
    }
    // Cheap keeps its own strategy (cache-optimized default), not free's
    // reset-aware — only the candidate filter is shared with free.
    expect(resolveVirtualAutoCombo("auto/coding:cheap").strategy).toBe(
      "cache-optimized"
    );
    // coding:cheap intersects both gates: free AND code-family.
    const codingCheap = resolveVirtualAutoCombo("auto/coding:cheap");
    const nonCoding = codingCheap.models.filter(
      (m) => !isCodingModelId(m.slice(m.indexOf("/") + 1))
    );
    expect(nonCoding).toEqual([]);
  });

  it("fallback path applies all gates and fails closed on empty", async () => {
    // Force the fallback branch: a 1m request no registry model can satisfy.
    const impossible = resolveVirtualAutoCombo("auto/best-free-1m", {});
    expect(impossible === null || impossible.models.length > 0).toBe(true);
    if (impossible) {
      // Every -1m model must prove its context window (fail closed on unknown).
      const { resolveKnownContextWindow } = await import(
        "../../open-sse/providers/capabilities.js"
      );
      for (const m of impossible.models) {
        const i = m.indexOf("/");
        const cw = resolveKnownContextWindow(m.slice(0, i), m.slice(i + 1));
        expect(cw).toBeGreaterThanOrEqual(1000000);
      }
    }
  });

  it("fallback entries exist in registry as chat-kind models", async () => {
    const { PROVIDERS } = await import(
      "../../open-sse/config/providers.js"
    );
    const { FREE_MODEL_BUDGETS } = await import(
      "../../open-sse/config/freeModelCatalog.data.js"
    );
    const freeKeys = new Set(
      FREE_MODEL_BUDGETS.map((f) =>
        `${f.provider}/${f.modelId}`.toLowerCase()
      )
    );
    const FALLBACK_SPOT_CHECKS = [
      // [modelStr, mustBeFree]
      ["tokenrouter/moonshotai/kimi-k3-free", false], // :free suffix
      ["tokenrouter/z-ai/glm-5.3-free", false], // :free suffix
      ["opencode/deepseek-v4-flash-free", true],
      ["opencode-go/ox-alpha-free", false], // :free suffix
      ["chatgpt-web/gpt-5.6-luna-free", true],
      ["bazaarlink/auto:free", true],
      ["anthropic/claude-sonnet-4-20250514", false],
      ["deepseek/deepseek-chat", false],
      ["tokenrouter/qwen/qwen3-coder-next", false],
      ["openai/gpt-4o", false],
    ];
    for (const [modelStr, mustBeFree] of FALLBACK_SPOT_CHECKS) {
      const i = modelStr.indexOf("/");
      const prov = modelStr.slice(0, i);
      const mid = modelStr.slice(i + 1);
      const reg = (PROVIDERS[prov]?.models || []).find((x) =>
        typeof x === "string" ? x === mid : x?.id === mid
      );
      expect(reg, `${modelStr} in registry`).toBeTruthy();
      const kind = typeof reg === "object" ? reg.kind || "chat" : "chat";
      expect(kind, `${modelStr} chat-kind`).toBe("chat");
      const isFree =
        freeKeys.has(modelStr.toLowerCase()) ||
        mid.endsWith(":free") ||
        mid.includes("free");
      if (mustBeFree) expect(isFree, `${modelStr} free`).toBe(true);
    }
  });

  it("applies p2c (Power of Two Choices) strategy rotation", () => {
    const models = ["model-a", "model-b", "model-c", "model-d"];
    const rotated = getRotatedModels(models, "test-p2c", "p2c");
    expect(rotated).toHaveLength(4);
    expect(models.includes(rotated[0])).toBe(true);
  });

  it("applies reset-aware strategy rotation based on time slot", () => {
    const models = ["model-a", "model-b", "model-c"];
    const rotated = getRotatedModels(models, "test-reset", "reset-aware");
    expect(rotated).toHaveLength(3);
    expect(models.includes(rotated[0])).toBe(true);
  });
});
