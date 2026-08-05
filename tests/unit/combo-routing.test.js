import { describe, it, expect, beforeEach } from "vitest";

import { getRotatedModels, resetComboRotation } from "../../open-sse/services/combo.js";

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
});
