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
          "gemini-3.7-flash-low": {
            displayName: "Gemini 3.7 Flash (Low)",
            quotaInfo: { remainingFraction: 0.4, resetTime: "2026-09-05T12:00:00Z" },
          },
          "claude-sonnet-4-6": {
            displayName: "Claude Sonnet 4.6 (Thinking)",
            quotaInfo: { remainingFraction: 0.7, resetTime: "2026-09-04T12:00:00Z" },
          },
          "claude-opus-4-6-thinking": {
            displayName: "Claude Opus 4.6 (Thinking)",
            quotaInfo: { remainingFraction: 0.2, resetTime: "2026-09-06T12:00:00Z" },
          },
          "gpt-oss-120b-medium": {
            displayName: "GPT-OSS 120B (Medium)",
            quotaInfo: { remainingFraction: 0.99, resetTime: "2026-09-03T12:00:00Z" },
          },
          "gemini-3.1-flash-image": {
            displayName: "Gemini 3.1 Flash (Image)",
            quotaInfo: { remainingFraction: 0.1, resetTime: "2026-09-03T12:00:00Z" },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity family rollup (Gemini total / Claude total)", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("emits min-fraction family rows with earliest reset", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    // Gemini: min(0.9, 0.4) = 0.4 → used 600/1000, earliest reset 09-03
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      used: 600,
      total: 1000,
      remainingPercentage: 40,
      displayName: "Gemini (all models)",
      family: "gemini",
      memberCount: 2,
    });
    expect(usage.quotas["Gemini (all models)"].resetAt).toBe("2026-09-03T12:00:00.000Z");

    // Claude: min(0.7, 0.2) = 0.2, earliest reset 09-04
    expect(usage.quotas["Claude (all models)"]).toMatchObject({
      used: 800,
      total: 1000,
      remainingPercentage: 20,
      displayName: "Claude (all models)",
      family: "claude",
      memberCount: 2,
    });
    expect(usage.quotas["Claude (all models)"].resetAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("keeps per-model rows and excludes image + non-family models from rollup", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    // Per-model rows intact
    expect(usage.quotas["gemini-3.8-flash-high"].remainingPercentage).toBe(90);
    expect(usage.quotas["gpt-oss-120b-medium"].remainingPercentage).toBe(99);
    // Image model present per-model but not counted in gemini members
    expect(usage.quotas["gemini-3.1-flash-image"].remainingPercentage).toBe(10);
    expect(usage.quotas["Gemini (all models)"].memberCount).toBe(2);
  });
});
