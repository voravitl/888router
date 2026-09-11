// Antigravity family rollup rows ("Gemini (all models)" / "Claude (all models)")
// carry `family` / `familyKey` / `memberCount` from the usage handler.
// parseQuotaData must forward them so QuotaTable's family-first sort
// (isFamily check) can lift the rollup bars above per-model rows.
// Regression test for issue #403.
import { describe, it, expect } from "vitest";
import { isFamilyRollup, parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("parseQuotaData antigravity family flag (#403)", () => {
  it("forwards family/familyKey/memberCount/displayName on rollup rows", () => {
    const data = {
      quotas: {
        "gemini-3.8-flash-high": {
          used: 100,
          total: 1000,
          resetAt: "2026-09-03T12:00:00.000Z",
          remainingPercentage: 90,
          unlimited: false,
          displayName: "Gemini 3.8 Flash (High)",
        },
        "Gemini (all models)": {
          used: 600,
          total: 1000,
          resetAt: "2026-09-03T12:00:00.000Z",
          remainingPercentage: 40,
          unlimited: false,
          displayName: "Gemini (all models)",
          family: "gemini",
          familyKey: "gemini",
          memberCount: 2,
        },
        "Claude (all models)": {
          used: 800,
          total: 1000,
          resetAt: "2026-09-04T12:00:00.000Z",
          remainingPercentage: 20,
          unlimited: false,
          displayName: "Claude (all models)",
          family: "claude",
          familyKey: "claude",
          memberCount: 2,
        },
      },
    };

    const out = parseQuotaData("antigravity", data);
    const byName = Object.fromEntries(out.map((q) => [q.name, q]));

    expect(byName["Gemini (all models)"].family).toBe("gemini");
    expect(byName["Gemini (all models)"].familyKey).toBe("gemini");
    expect(byName["Gemini (all models)"].memberCount).toBe(2);
    expect(byName["Gemini (all models)"].displayName).toBe("Gemini (all models)");
    expect(byName["Claude (all models)"].family).toBe("claude");
    expect(byName["Claude (all models)"].familyKey).toBe("claude");
    expect(byName["Claude (all models)"].memberCount).toBe(2);
    // Per-model rows stay non-family so the family-first sort partitions.
    expect(byName["Gemini 3.8 Flash (High)"].family).toBeUndefined();
  });

  it("fails closed on malformed family metadata (never pins junk rows)", () => {
    const data = {
      quotas: {
        "Bogus (all models)": {
          used: 1, total: 100, resetAt: null, remainingPercentage: 99,
          displayName: "Bogus (all models)", family: "", familyKey: "", memberCount: 0,
        },
        "Weird (all models)": {
          used: 1, total: 100, resetAt: null, remainingPercentage: 99,
          displayName: "Weird (all models)", family: "gemini", familyKey: "gemini", memberCount: -2,
        },
        "Mismatch (all models)": {
          used: 1, total: 100, resetAt: null, remainingPercentage: 99,
          displayName: "Mismatch (all models)", family: "gemini", familyKey: "claude", memberCount: 3,
        },
      },
    };

    const out = parseQuotaData("antigravity", data);
    for (const q of out) {
      expect(isFamilyRollup(q)).toBe(false);
    }
  });

  it("isFamilyRollup accepts only backend-shaped rollups", () => {
    expect(isFamilyRollup({ family: "gemini", familyKey: "gemini", memberCount: 2 })).toBe(true);
    expect(isFamilyRollup({ family: "claude", familyKey: "claude", memberCount: 1 })).toBe(true);
    expect(isFamilyRollup({ family: "", familyKey: "", memberCount: 1 })).toBe(false);
    expect(isFamilyRollup({ family: "gemini", familyKey: "gemini", memberCount: 0 })).toBe(false);
    expect(isFamilyRollup({ family: "gemini", familyKey: "gemini", memberCount: 1.5 })).toBe(false);
    expect(isFamilyRollup({ family: "gpt", familyKey: "gpt", memberCount: 2 })).toBe(false);
    expect(isFamilyRollup({})).toBe(false);
    expect(isFamilyRollup(null)).toBe(false);
  });
});
