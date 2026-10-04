import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { resolveAntigravityFlashModel } from "../../open-sse/providers/models/helpers.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

describe("Antigravity requested Gemini Flash identity", () => {
  // Own live telemetry on 2026-10-03 showed eight requested 3.8 calls silently
  // sent as 3.6. Transport must retain the requested version, not guess capacity.
  it.each([
    "gemini-3.7-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
    "gemini-3.10-flash-high", "gemini-4.0-flash-low", "gemini-5.2-flash-high",
    "gemini-3.8-flash", "gemini-3.6-flash-high", "gemini-3.5-flash-low",
  ])("preserves %s through helper, catalog and executor", (model) => {
    expect(resolveAntigravityFlashModel(model)).toBe(model);
    expect(getModelUpstreamId("ag", model)).toBe(model);
    const result = new AntigravityExecutor().transformRequest(model, {
      request: { contents: [], generationConfig: { maxOutputTokens: 256 } },
    }, false, { projectId: "test-project" });
    expect(result.model).toBe(model);
    expect(result.request.generationConfig.maxOutputTokens).toBe(256);
  });

  it("normalizes recognized spelling without changing model version or thinking tier", () => {
    expect(resolveAntigravityFlashModel("gemini-3.8-flash-HIGH")).toBe("gemini-3.8-flash-high");
    expect(resolveAntigravityFlashModel("Gemini-3.10-Flash-LOW")).toBe("gemini-3.10-flash-low");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-high(high)")).toBe("gemini-3.8-flash-high(high)");
  });

  it.each([null, undefined, "", "claude-opus-5.5", "gemini-3.8-flash-lite", "gemini-3.8-flash-tiered"])("preserves IDs outside the recognized spelling: %s", model => {
    expect(resolveAntigravityFlashModel(model)).toBe(model);
  });
});
