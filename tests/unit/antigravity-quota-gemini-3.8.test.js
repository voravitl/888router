import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : {
        models: {
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-09-03T12:00:00Z" },
          },
          "gemini-3.8-flash-medium": {
            displayName: "Gemini 3.8 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.75, resetTime: "2026-09-03T12:00:00Z" },
          },
          "gemini-3.8-flash-low": {
            displayName: "Gemini 3.8 Flash (Low)",
            quotaInfo: { remainingFraction: 0.45, resetTime: "2026-09-03T12:00:00Z" },
          },
          "gemini-3.7-flash-high": {
            displayName: "Gemini 3.7 Flash (High)",
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-14T12:00:00Z" },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.8 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.8 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      used: 100,
      total: 1000,
      remainingPercentage: 90,
      displayName: "Gemini 3.8 Flash (High)",
    });
    expect(usage.quotas["gemini-3.8-flash-medium"]).toMatchObject({
      used: 250,
      total: 1000,
      remainingPercentage: 75,
      displayName: "Gemini 3.8 Flash (Medium)",
    });
    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 550,
      total: 1000,
      remainingPercentage: 45,
      displayName: "Gemini 3.8 Flash (Low)",
    });
  });

  beforeEach(async () => {
    const { resetAntigravityMaxDeployedFlashVersionForTests } = await import("../../open-sse/providers/models/helpers.js");
    resetAntigravityMaxDeployedFlashVersionForTests();
  });

  it("resolves upstreamModelId dynamically for Gemini 3.8 and future Flash variants to Gemini 3.6 Flash without hardcoding", async () => {
    const { getModelUpstreamId, isValidModel, findModelName } = await import("../../open-sse/config/providerModels.js");
    const {
      resolveAntigravityFlashModel,
      setAntigravityMaxDeployedFlashVersion,
      resetAntigravityMaxDeployedFlashVersionForTests,
    } = await import("../../open-sse/providers/models/helpers.js");
    const { normalizeModel } = await import("../../open-sse/providers/models/schema.js");

    try {
      expect(getModelUpstreamId("ag", "gemini-3.8-flash-high")).toBe("gemini-3.6-flash-high");
      expect(getModelUpstreamId("ag", "gemini-3.8-flash-medium")).toBe("gemini-3.6-flash-medium");
      expect(getModelUpstreamId("ag", "gemini-3.8-flash-low")).toBe("gemini-3.6-flash-low");

      // Two-digit minor version compare (3.10 > 3.6)
      expect(getModelUpstreamId("ag", "gemini-3.10-flash-high")).toBe("gemini-3.6-flash-high");

      // Case-insensitive tier normalization
      expect(resolveAntigravityFlashModel("gemini-3.8-flash-HIGH")).toBe("gemini-3.6-flash-high");

      // Dynamic future versions without registration
      expect(getModelUpstreamId("ag", "gemini-3.9-flash-high")).toBe("gemini-3.6-flash-high");
      expect(getModelUpstreamId("ag", "gemini-4.0-flash-low")).toBe("gemini-3.6-flash-low");
      expect(getModelUpstreamId("ag", "gemini-4.5-flash")).toBe("gemini-3.6-flash-medium");

      expect(isValidModel("ag", "gemini-3.9-flash-high")).toBe(true);
      expect(isValidModel("ag", "gemini-4.0-flash-high")).toBe(true);
      expect(findModelName("ag", "gemini-3.9-flash-high")).toBe("Gemini 3.9 Flash High");

      // Wild typos rejected across both catalog and wire paths (SSOT)
      expect(isValidModel("ag", "gemini-999-flash-high")).toBe(false);
      expect(getModelUpstreamId("ag", "gemini-999-flash-high")).toBe("gemini-999-flash-high");
      expect(resolveAntigravityFlashModel("gemini-999-flash-high")).toBe("gemini-999-flash-high");

      // Current and legacy models remain untouched
      expect(getModelUpstreamId("ag", "gemini-3.6-flash-high")).toBe("gemini-3.6-flash-high");
      expect(getModelUpstreamId("ag", "gemini-3.5-flash-low")).toBe("gemini-3.5-flash-low");

      // Provider isolation: normalizeModel and getModelUpstreamId must not alter other providers
      const nonAgModel = normalizeModel({ id: "gemini-3.8-flash-high" });
      expect(nonAgModel.upstreamModelId).toBeUndefined();
      expect(getModelUpstreamId("gc", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
      expect(getModelUpstreamId("gemini-cli", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
      expect(getModelUpstreamId("google", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");

      // Ceiling promotion and test reset
      setAntigravityMaxDeployedFlashVersion("3.8");
      expect(resolveAntigravityFlashModel("gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
      expect(resolveAntigravityFlashModel("gemini-3.9-flash-high")).toBe("gemini-3.8-flash-high");
    } finally {
      resetAntigravityMaxDeployedFlashVersionForTests();
    }
  });

  it("AntigravityExecutor transformRequest resolves Gemini 3.8 Flash to deployed 3.6 tier", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const executor = new AntigravityExecutor();

    const transformed = executor.transformRequest(
      "gemini-3.8-flash-high",
      { contents: [] },
      false,
      { projectId: "test-proj" }
    );

    expect(transformed.model).toBe("gemini-3.6-flash-high");
  });
});
