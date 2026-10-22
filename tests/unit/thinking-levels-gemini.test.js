import { describe, it, expect } from "vitest";

// The thinking-level table decides what the gateway may send upstream. When
// it offers a level the model rejects, the request fails with a 400 that the
// client cannot act on.
//
// Verified live on antigravity 2026-10-22 (each probe was a real call, and
// every response was read — an earlier probe only grepped for the word
// MINIMAL and mistook a capacity 503 for a pass):
//   ag/gemini-3.8-flash-high(none)    → 400 "Thinking level MINIMAL is not
//                                        supported for this model"
//   ag/gemini-3.8-flash-low(none)     → 400 (same)
//   ag/gemini-3.8-flash-medium(none)  → 400 (same)
//   ag/gemini-3.8-flash-tiered(none)  → 400 (same)
//   ag/gemini-3-flash(none)           → 200
//   ag/gemini-3.1-flash-lite(none)    → 200
//   ag/gemini-3.1-flash-image(none)   → 200
//   ag/gemini-3.5-flash-lite(none)    → 200
//   ag/gemini-2.5-flash(none)         → 200
//
// "(none)" is the path that breaks: a client that turns thinking off is
// translated to thinkingLevel "minimal" (thinkingUnified.js), because gemini
// has no "disable" tier — so the model must be able to accept "minimal".
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const levels = (provider, model) => getThinkingLevels(provider, model);

describe("gemini thinking levels", () => {
  it("offers only levels the model accepts (no 'minimal' where it 400s)", () => {
    // The whole tiered gemini-3.8 flash family rejects "minimal".
    for (const model of [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-tiered",
    ]) {
      expect(levels("antigravity", model), model).toEqual(["low", "medium", "high"]);
    }
  });

  it("keeps 'minimal' for the UNTIERED gemini-3.8 flash", () => {
    // "gemini-3.8-flash" (no tier) is the plain Google model, not the
    // antigravity tier — it still accepts "minimal". The pattern carries a
    // trailing dash on purpose so the two stay apart.
    expect(levels("gemini", "gemini-3.8-flash")).toContain("minimal");
  });

  it("keeps 'minimal' where the model does accept it", () => {
    // The gemini-3.x line uses the "gemini-level" format: it has no "none"
    // tier, so "minimal" is how thinking is turned down — the model must be
    // able to accept it.
    for (const model of [
      "gemini-3-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
    ]) {
      expect(levels("antigravity", model), model).toContain("minimal");
    }
  });

  it("leaves a model with no reasoning alone (no levels at all)", () => {
    // The image model has no reasoning, so there is nothing to clamp.
    expect(levels("antigravity", "gemini-3.1-flash-image")).toBeNull();
  });

  it("leaves the older budget-format gemini alone (it can disable thinking)", () => {
    // The gemini-2.5 line uses "gemini-budget": it has a real "none" tier, so
    // it never needs "minimal" and must not be touched by the 3.8 patterns.
    for (const model of ["gemini-2.5-flash", "gemini-2.5-pro"]) {
      expect(levels("antigravity", model), model).toEqual(["none", "low", "medium", "high"]);
    }
  });

  it("keeps the Argon floor (gemini-4 rejects 'minimal' too)", () => {
    expect(levels("antigravity", "gemini-4-argon-high")).toEqual(["low", "medium", "high"]);
    expect(levels("nousresearch", "gemini-4-argon")).toEqual(["low", "medium", "high"]);
  });
});
