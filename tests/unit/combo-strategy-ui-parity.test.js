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
];

describe("combo strategy UI/backend parity", () => {
  it("every strategy the UI can persist has a backend implementation", () => {
    for (const id of UI_ROTATION_STRATEGIES) {
      expect(COMBO_ROTATION_STRATEGIES.has(id)).toBe(true);
    }
  });

  it("help-modal entries marked planned are exactly the unimplemented ones", () => {
    const planned = STRATEGY_DETAILS.filter((s) => s.planned).map((s) => s.id);
    const active = STRATEGY_DETAILS.filter((s) => !s.planned).map((s) => s.id);
    expect(active).toEqual([...UI_ROTATION_STRATEGIES, "fusion"]);
    expect(planned).toEqual(["cost-optimized", "headroom", "least-used", "random"]);
    for (const id of planned) {
      expect(COMBO_ROTATION_STRATEGIES.has(id)).toBe(false);
    }
  });

  it("active strategy count matches the documented entries", () => {
    expect(ACTIVE_STRATEGY_COUNT).toBe(6);
    expect(ACTIVE_STRATEGY_COUNT).toBe(STRATEGY_DETAILS.length - STRATEGY_DETAILS.filter((s) => s.planned).length);
  });

  it("planned entries are labelled as not selectable", () => {
    for (const s of STRATEGY_DETAILS.filter((x) => x.planned)) {
      expect(s.summary).toContain("not yet implemented in the gateway");
      expect(s.summary).toContain("selecting is disabled");
    }
  });
});