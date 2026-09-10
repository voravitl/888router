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
    // Compact/fused specialist spellings (no delimiter before version).
    expect(isCodingModelId("codellama-70b")).toBe(true);
    expect(isCodingModelId("codegemma-7b")).toBe(true);
    expect(isCodingModelId("starcoder2-15b")).toBe(true);
    expect(isCodingModelId("deepseekcoder-v2")).toBe(true);
    expect(isCodingModelId("codestral22b")).toBe(true);
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
    // Property test over every resolvable auto/ combo: each returned member
    // must satisfy the request's own gates (tier, context, category) AND be
    // a registered chat-kind model. Covers normal + fallback branches alike.
    const { PROVIDERS } = await import(
      "../../open-sse/config/providers.js"
    );
    const { resolveKnownContextWindow } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    const combos = [
      "auto/best-free",
      "auto/best-free-1m",
      "auto/free-1m",
      "auto/best-coding",
      "auto/cheap",
      "auto/coding:cheap",
      "auto/coding:free",
      "auto/vision:free",
      "auto/reasoning:free",
    ];
    for (const name of combos) {
      const combo = resolveVirtualAutoCombo(name);
      expect(combo, `${name} resolves`).not.toBeNull();
      expect(combo.models.length, `${name} non-empty`).toBeGreaterThan(0);
      const isFreeTier = name.includes("free") || name.includes("cheap");
      const needs1m = name.includes("1m");
      const needsCoding = name.includes("coding");
      for (const m of combo.models) {
        const i = m.indexOf("/");
        expect(i, `${m} has provider/model shape`).toBeGreaterThan(0);
        const prov = m.slice(0, i);
        const mid = m.slice(i + 1);
        if (isFreeTier) {
          expect(isFreeCandidate(prov, mid), `${m} free`).toBe(true);
        }
        if (needs1m) {
          const cw = resolveKnownContextWindow(prov, mid);
          expect(cw, `${m} cw>=1m`).toBeGreaterThanOrEqual(1000000);
        }
        if (needsCoding) {
          expect(isCodingModelId(mid), `${m} coding`).toBe(true);
        }
        const reg = (PROVIDERS[prov]?.models || []).find((x) =>
          typeof x === "string"
            ? x.toLowerCase() === mid.toLowerCase()
            : x?.id?.toLowerCase() === mid.toLowerCase()
        );
        expect(reg, `${m} in registry`).toBeTruthy();
        const kind = typeof reg === "object" ? reg.kind || "chat" : "chat";
        expect(kind, `${m} chat-kind`).toBe("chat");
      }
      // No duplicate members.
      expect(new Set(combo.models).size, `${name} deduped`).toBe(
        combo.models.length
      );
    }
  });

  it("fallback entries pass their own branch gates (build-time validation)", async () => {
    // Each fallback list entry must pass the gates of the branch that
    // contains it — using the SAME production predicates (not duplicated
    // partial logic). Validates registry presence + chat-kind + the branch's
    // tier/context/category gates.
    const { PROVIDERS } = await import(
      "../../open-sse/config/providers.js"
    );
    const { resolveKnownContextWindow } = await import(
      "../../open-sse/providers/capabilities.js"
    );
    // [modelStr, branch]: branch gates mirror the FALLBACKS selection.
    const FALLBACK_SPOT_CHECKS = [
      ["tokenrouter/moonshotai/kimi-k3-free", "free-1m"],
      ["tokenrouter/z-ai/glm-5.3-free", "free-1m"],
      ["opencode/deepseek-v4-flash-free", "free-1m"],
      ["opencode-go/ox-alpha-free", "free-1m"],
      ["chatgpt-web/gpt-5.6-luna-free", "free-1m"],
      ["opencode/deepseek-v4-flash-free", "free"],
      ["chatgpt-web/gpt-5.6-luna-free", "free"],
      ["bazaarlink/auto:free", "free"],
      ["anthropic/claude-sonnet-4-20250514", "coding"],
      ["tokenrouter/qwen/qwen3-coder-next", "coding"],
      ["tokenrouter/moonshotai/kimi-k2.7-code", "coding"],
      ["openai/gpt-4o", "general"],
    ];
    for (const [modelStr, branch] of FALLBACK_SPOT_CHECKS) {
      const i = modelStr.indexOf("/");
      expect(i, `${modelStr} has slash`).toBeGreaterThan(0);
      const prov = modelStr.slice(0, i);
      const mid = modelStr.slice(i + 1);
      const reg = (PROVIDERS[prov]?.models || []).find((x) =>
        typeof x === "string"
          ? x.toLowerCase() === mid.toLowerCase()
          : x?.id?.toLowerCase() === mid.toLowerCase()
      );
      expect(reg, `${modelStr} in registry`).toBeTruthy();
      const kind = typeof reg === "object" ? reg.kind || "chat" : "chat";
      expect(kind, `${modelStr} chat-kind`).toBe("chat");
      if (branch === "free-1m" || branch === "free") {
        expect(isFreeCandidate(prov, mid), `${modelStr} free`).toBe(true);
      }
      if (branch === "free-1m") {
        const cw = resolveKnownContextWindow(prov, mid);
        expect(cw, `${modelStr} cw>=1m`).toBeGreaterThanOrEqual(1000000);
      }
      if (branch === "coding") {
        expect(isCodingModelId(mid), `${modelStr} coding`).toBe(true);
      }
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
