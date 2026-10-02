import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  COMBO_ROTATION_STRATEGIES,
  clearComboHeadTimeoutCooldown,
  clearComboUnknownStrategyWarnings,
  getComboHeadTimeoutCooldown,
  getRotatedModels,
  markComboHeadTimeout,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("returns input order untouched for strategies with no backend implementation", () => {
    clearComboUnknownStrategyWarnings();
    const models = ["provider/model-a", "provider/model-b"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Every strategy the UI offers but the engine never implemented degrades
      // to plain list order — the combo behaves as fallback.
      for (const strategy of ["headroom", "cost-optimized", "least-used", "random"]) {
        expect(COMBO_ROTATION_STRATEGIES.has(strategy)).toBe(false);
        expect(getRotatedModels(models, "code-xhigh", strategy, 2)).toEqual(models);
      }
      // Known strategies stay implemented (round-robin rotates the start
      // across calls with sticky 1; p2c/reset-aware reorder by construction).
      resetComboRotation();
      const first = getRotatedModels(models, "code-rr-check", "round-robin", 1)[0];
      const second = getRotatedModels(models, "code-rr-check", "round-robin", 1)[0];
      expect([first, second].sort()).toEqual(["provider/model-a", "provider/model-b"]);
      expect(first).not.toBe(second);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns exactly once per process for an unknown strategy", () => {
    clearComboUnknownStrategyWarnings();
    const models = ["provider/model-a", "provider/model-b"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getRotatedModels(models, "combo-a", "headroom");
      getRotatedModels(models, "combo-b", "headroom");
      getRotatedModels(models, "combo-a", "cost-optimized");
      const headroomWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('"headroom"'));
      const costWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('"cost-optimized"'));
      expect(headroomWarns).toHaveLength(1);
      expect(costWarns).toHaveLength(1);
      expect(String(headroomWarns[0][0])).toContain("using list order (fallback)");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for implemented strategies", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const strategy of ["fallback", "round-robin", "cache-optimized", "p2c", "reset-aware", "reset-window"]) {
        getRotatedModels(models, "code-xhigh", strategy, 1, strategy === "cache-optimized" ? { messages: [] } : null);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("combo stream-head timeout cooldown", () => {
  afterEach(() => {
    clearComboHeadTimeoutCooldown();
  });

  it("parks a model for 30s after markComboHeadTimeout", () => {
    const before = Date.now();
    markComboHeadTimeout("provider/model-a");
    const until = getComboHeadTimeoutCooldown("provider/model-a");
    expect(until).toBeGreaterThan(before);
    expect(until - before).toBeLessThanOrEqual(30 * 1000);
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBe(0);
  });

  it("clearComboHeadTimeoutCooldown clears one model or all", () => {
    markComboHeadTimeout("provider/model-a");
    markComboHeadTimeout("provider/model-b");
    clearComboHeadTimeoutCooldown("provider/model-a");
    expect(getComboHeadTimeoutCooldown("provider/model-a")).toBe(0);
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBeGreaterThan(0);
    clearComboHeadTimeoutCooldown();
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBe(0);
  });
});

describe("combo modelError fallback rules", () => {
  it("classifies permanent model-level errors as modelError", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    const notSupported = checkFallbackError(400, "Model deepseek-v4-flash-free is not supported");
    expect(notSupported.shouldFallback).toBe(false);
    expect(notSupported.modelError).toBe(true);

    const notFoundText = checkFallbackError(400, "model not found");
    expect(notFoundText.shouldFallback).toBe(false);
    expect(notFoundText.modelError).toBe(true);

    const status404 = checkFallbackError(404, "Not Found");
    expect(status404.shouldFallback).toBe(false);
    expect(status404.modelError).toBe(true);

    // Standard rate limit should still be account fallback, not model error
    const rateLimit = checkFallbackError(429, "Rate limit exceeded");
    expect(rateLimit.shouldFallback).toBe(true);
    expect(rateLimit.modelError).toBeUndefined();
  });

  it("classifies Kiro MODEL_TEMPORARILY_UNAVAILABLE as a model-level error (not account fallback)", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    // Kiro 500 returns {"message":"...high load...","reason":"MODEL_TEMPORARILY_UNAVAILABLE"}
    // The executor already retries the 500 a couple times; account rotation is pointless
    // (the model is overloaded for everyone), so it must NOT mark accounts for fallback.
    const overloaded = checkFallbackError(500, '{"message":"Encountered unexpectedly high load when processing the request, please try again.","reason":"MODEL_TEMPORARILY_UNAVAILABLE"}');
    expect(overloaded.shouldFallback).toBe(false);
    expect(overloaded.modelError).toBe(true);
    expect(overloaded.cooldownMs).toBe(0);
  });

  it("classifies OpenCode ModelError and promotion has ended as model-level errors", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    const opencodeModelError = checkFallbackError(401, '{"type":"error","error":{"type":"ModelError","message":"Free promotion has ended for DeepSeek V4 Flash Free. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go"}}');
    expect(opencodeModelError.shouldFallback).toBe(false);
    expect(opencodeModelError.modelError).toBe(true);
    expect(opencodeModelError.cooldownMs).toBe(0);

    const promotionEnded = checkFallbackError(400, "promotion has ended for this model");
    expect(promotionEnded.shouldFallback).toBe(false);
    expect(promotionEnded.modelError).toBe(true);
    expect(promotionEnded.cooldownMs).toBe(0);
  });
});
