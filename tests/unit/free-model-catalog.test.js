import { describe, it, expect } from "vitest";
import {
  computeFreeModelTotals,
  grantsFreeAccess,
  FREE_MODEL_BUDGETS,
  FREE_REGIME_TRAITS,
} from "../../open-sse/config/freeModelCatalog.js";

describe("Free Model Catalog & Deduplicated Quota Engine", () => {
  it("classifies free access regimes correctly", () => {
    expect(grantsFreeAccess("recurring-daily")).toBe(true);
    expect(grantsFreeAccess("recurring-monthly")).toBe(true);
    expect(grantsFreeAccess("keyless")).toBe(true);
    expect(grantsFreeAccess("discontinued")).toBe(false);
  });

  it("computes pool-deduplicated monthly token totals across free catalog", () => {
    const totals = computeFreeModelTotals();

    expect(totals.modelCount).toBeGreaterThanOrEqual(400);
    expect(totals.poolCount).toBeGreaterThanOrEqual(30);
    expect(totals.steadyRecurringTokens).toBeGreaterThan(1_000_000_000); // > 1 Billion tokens/mo
    expect(totals.uncappedProviders.length).toBeGreaterThanOrEqual(3);
    expect(typeof totals.headline).toBe("string");
  });

  it("filters out avoid-TOS entries when excludeTosAvoid is requested", () => {
    const allTotals = computeFreeModelTotals({ excludeTosAvoid: false });
    const safeTotals = computeFreeModelTotals({ excludeTosAvoid: true });

    expect(safeTotals.modelCount).toBeLessThan(allTotals.modelCount);
    expect(safeTotals.steadyRecurringTokens).toBeLessThanOrEqual(allTotals.steadyRecurringTokens);
  });
});
