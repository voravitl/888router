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

  it("resolves upstreamModelId for Gemini 3.8 Flash variants directly without down-mapping", async () => {
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");

    expect(getModelUpstreamId("ag", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-high");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-medium")).toBe("gemini-3.8-flash-medium");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-low")).toBe("gemini-3.8-flash-low");
  });
});
