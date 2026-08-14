import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : {
        models: {
          "gemini-3.7-flash-high": {
            displayName: "Gemini 3.7 Flash (High)",
            quotaInfo: { remainingFraction: 0.85, resetTime: "2026-08-14T12:00:00Z" },
          },
          "gemini-3.7-flash-medium": {
            displayName: "Gemini 3.7 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2026-08-14T12:00:00Z" },
          },
          "gemini-3.7-flash-low": {
            displayName: "Gemini 3.7 Flash (Low)",
            quotaInfo: { remainingFraction: 0.3, resetTime: "2026-08-14T12:00:00Z" },
          },
          "gemini-3.6-flash-high": {
            displayName: "Gemini 3.6 Flash (High)",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
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

describe("Antigravity quota tracker: Gemini 3.7 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.7 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.7-flash-high"]).toMatchObject({
      used: 150,
      total: 1000,
      remainingPercentage: 85,
      displayName: "Gemini 3.7 Flash (High)",
    });
    expect(usage.quotas["gemini-3.7-flash-medium"]).toMatchObject({
      used: 400,
      total: 1000,
      remainingPercentage: 60,
      displayName: "Gemini 3.7 Flash (Medium)",
    });
    expect(usage.quotas["gemini-3.7-flash-low"]).toMatchObject({
      used: 700,
      total: 1000,
      remainingPercentage: 30,
      displayName: "Gemini 3.7 Flash (Low)",
    });
  });

  it("filters out internal models and includes Gemini 3.7 Flash models", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas).not.toHaveProperty("internal-model");
    expect(Object.keys(usage.quotas)).toEqual([
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
      "gemini-3.7-flash-low",
      "gemini-3.6-flash-high",
    ]);
  });

  it("resolves upstreamModelId for Gemini 3.7 Flash variants to Gemini 3.6 Flash", async () => {
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");

    expect(getModelUpstreamId("ag", "gemini-3.7-flash-high")).toBe("gemini-3.6-flash-high");
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-medium")).toBe("gemini-3.6-flash-medium");
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-low")).toBe("gemini-3.6-flash-low");
    expect(getModelUpstreamId("ag", "gemini-3.6-flash-high")).toBe("gemini-3.6-flash-high");
  });
});

