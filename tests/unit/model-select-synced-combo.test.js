import { describe, it, expect, vi } from "vitest";
import { getModelInfo, getComboModels } from "@/sse/services/model.js";
import { resolveVirtualAutoCombo } from "open-sse/services/autoCombo/virtualFactory.js";

describe("Model Routing & Combo Resolution with Synced Models", () => {
  it("resolves auto/* virtual combos with provider null in getModelInfo", async () => {
    const info = await getModelInfo("auto/coding:pro");
    expect(info).toEqual({ provider: null, model: "auto/coding:pro" });
  });

  it("resolves auto/best-free with provider null in getModelInfo", async () => {
    const info = await getModelInfo("auto/best-free");
    expect(info).toEqual({ provider: null, model: "auto/best-free" });
  });

  it("returns candidates from resolveVirtualAutoCombo without ESM require errors", () => {
    const result = resolveVirtualAutoCombo("auto/coding:pro");
    expect(result).not.toBeNull();
    expect(result.name).toBe("auto/coding:pro");
    expect(Array.isArray(result.models)).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("fetches combo models for virtual auto combo", async () => {
    const models = await getComboModels("auto/coding:fast");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it("handles null or empty model string safely", async () => {
    const info = await getModelInfo("");
    expect(info).toEqual({ provider: null, model: null });
  });
});
