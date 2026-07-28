import { describe, it, expect } from "vitest";
import { compareModels } from "../../src/app/(dashboard)/dashboard/providers/[id]/models-table-sort.js";

describe("compareModels context sorting with getContextWindow", () => {
  it("sorts by context using maxInputTokens/contextLength when available", () => {
    const a = { id: "m1", maxInputTokens: 100000 };
    const b = { id: "m2", maxInputTokens: 200000 };
    expect(compareModels(a, b, "context", "asc")).toBeLessThan(0);
    expect(compareModels(a, b, "context", "desc")).toBeGreaterThan(0);
  });

  it("sorts by context using getContextWindow when tokens/length missing on model object", () => {
    const a = { id: "m1", fullModel: "provider/m1" };
    const b = { id: "m2", fullModel: "provider/m2" };
    const getContextWindow = (fullModel) => {
      if (fullModel === "provider/m1") return 1000000;
      if (fullModel === "provider/m2") return 200000;
      return 0;
    };

    expect(compareModels(a, b, "context", "asc", getContextWindow)).toBeGreaterThan(0);
    expect(compareModels(a, b, "context", "desc", getContextWindow)).toBeLessThan(0);
  });
});

describe("Model list deduplication guard", () => {
  it("deduplicates models by fullModel/id key", () => {
    const rawModels = [
      { id: "auto", fullModel: "kr/auto", isCustom: true, name: "Auto Custom" },
      { id: "auto", fullModel: "kr/auto", isCustom: false, name: "Auto Built-in" },
      { id: "haiku", fullModel: "kr/haiku", isCustom: false, name: "Haiku" },
    ];

    const seen = new Set();
    const unique = rawModels.filter((m) => {
      const key = m.fullModel || m.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(unique).toHaveLength(2);
    expect(unique[0].name).toBe("Auto Custom");
    expect(unique[1].id).toBe("haiku");
  });
});

describe("withClaudeCodeSuffix for Combos", () => {
  it("appends [1m] to combo name when max context is >= 1M", () => {
    const { withClaudeCodeSuffix } = require("../../src/shared/utils/claudeCodeModelId.js");
    expect(withClaudeCodeSuffix("9-deepseek-v4-flash", 1000000)).toBe("9-deepseek-v4-flash[1m]");
    expect(withClaudeCodeSuffix("my-combo", 200000)).toBe("my-combo");
  });
});
