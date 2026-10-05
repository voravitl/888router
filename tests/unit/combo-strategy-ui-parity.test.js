import { describe, it, expect } from "vitest";

import {
  ACTIVE_STRATEGY_COUNT,
  STRATEGY_DETAILS,
} from "../../src/shared/constants/comboStrategies.js";
import { COMBO_ROTATION_STRATEGIES } from "../../open-sse/services/combo.js";

// Strategies the combos page select can persist into
// settings.comboStrategies[name].fallbackStrategy. `fusion` is dispatched by
// chat.js BEFORE getRotatedModels() ever runs, so it is exempt from the
// rotation-strategy set.
const UI_ROTATION_STRATEGIES = [
  "fallback",
  "round-robin",
  "cache-optimized",
  "p2c",
  "reset-aware",
  "reset-window",
  "cost-optimized",
  "headroom",
  "least-used",
  "random",
];

describe("combo strategy UI/backend parity", () => {
  it("every strategy the UI can persist has a backend implementation", () => {
    for (const id of UI_ROTATION_STRATEGIES) {
      expect(COMBO_ROTATION_STRATEGIES.has(id)).toBe(true);
    }
  });

  it("no strategy is left planned — everything offered is implemented", () => {
    const planned = STRATEGY_DETAILS.filter((s) => s.planned).map((s) => s.id);
    const active = STRATEGY_DETAILS.filter((s) => !s.planned).map((s) => s.id);
    expect(planned).toEqual([]);
    expect(active).toEqual([...UI_ROTATION_STRATEGIES, "fusion"]);
  });

  it("reset-window is a selectable strategy (not documentation-only)", () => {
    expect(UI_ROTATION_STRATEGIES).toContain("reset-window");
    expect(COMBO_ROTATION_STRATEGIES.has("reset-window")).toBe(true);
    expect(STRATEGY_DETAILS.some((s) => s.id === "reset-window" && !s.planned)).toBe(true);
  });

  it("active strategy count matches the documented entries", () => {
    expect(ACTIVE_STRATEGY_COUNT).toBe(11);
    expect(ACTIVE_STRATEGY_COUNT).toBe(STRATEGY_DETAILS.length - STRATEGY_DETAILS.filter((s) => s.planned).length);
  });

  it("engine registry, UI set, and modal entries stay in lockstep", () => {
    const uiSet = new Set(UI_ROTATION_STRATEGIES);
    // Engine (minus fusion, which dispatches upstream) == UI set.
    expect(new Set([...COMBO_ROTATION_STRATEGIES])).toEqual(uiSet);
    // Modal lists exactly the UI set plus fusion.
    const modalIds = STRATEGY_DETAILS.map((s) => s.id);
    expect(new Set(modalIds)).toEqual(new Set([...UI_ROTATION_STRATEGIES, "fusion"]));
    for (const s of STRATEGY_DETAILS) {
      expect(s.summary).not.toContain("not yet implemented in the gateway");
    }
  });
});