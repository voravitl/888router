import { describe, it, expect } from "vitest";
import { parseAutoSuffix } from "../../open-sse/services/autoCombo/suffixComposition.js";
import { resolveVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.js";
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
