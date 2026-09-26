import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const weeklySummary = (
  geminiRemainingFraction = 0.75,
  geminiResetTime = "2026-09-15T00:00:00Z",
  claudeRemainingFraction = 0.5,
  claudeResetTime = "2026-09-16T00:00:00Z"
) => ({
  groups: [{
    displayName: "Gemini Models",
    buckets: [{
      bucketId: "gemini-weekly",
      displayName: "Weekly Limit",
      remainingFraction: geminiRemainingFraction,
      resetTime: geminiResetTime,
    }],
  }, {
    displayName: "Claude and GPT models",
    buckets: [{
      bucketId: "claude-gpt-weekly",
      displayName: "Weekly Limit",
      remainingFraction: claudeRemainingFraction,
      resetTime: claudeResetTime,
    }],
  }],
});

function mockUsage({ paidTierId = "pro-tier", models, weekly = weeklySummary() }) {
  proxyAwareFetch.mockImplementation(async (url) => {
    if (url.includes(":loadCodeAssist")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cloudaicompanionProject: "project-1",
          currentTier: { name: paidTierId === "free-tier" ? "Starter" : "Pro" },
          paidTier: { id: paidTierId },
        }),
      };
    }
    if (url.includes(":fetchAvailableModels")) {
      return { ok: true, status: 200, json: async () => ({ models }) };
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      return { ok: true, status: 200, json: async () => weekly };
    }
    return { ok: false, status: 404 };
  });
}

describe("Antigravity weekly quota overlay", () => {
  beforeEach(async () => {
    proxyAwareFetch.mockReset();
    const { _clearWeeklyCache } = await import("../../open-sse/services/usage/antigravity-weekly.js");
    _clearWeeklyCache();
  });

  it("skips misleading per-model quotas for free-tier accounts", async () => {
    mockUsage({
      paidTierId: "free-tier",
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 1, resetTime: "2026-09-10T00:00:00Z" },
        },
      },
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toBeUndefined();
    expect(usage.quotas["Gemini (all models)"]).toBeUndefined();
    expect(usage.quotas.gemini_weekly).toMatchObject({
      used: 250,
      total: 1000,
      remainingPercentage: 75,
    });
  });

  it("skips misleading per-model quotas for starter-tier accounts with truthy paidTierId", async () => {
    mockUsage({
      paidTierId: "starter-tier",
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 1, resetTime: "2026-09-10T00:00:00Z" },
        },
      },
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toBeUndefined();
    expect(usage.quotas["Gemini (all models)"]).toBeUndefined();
    expect(usage.quotas.gemini_weekly).toMatchObject({
      used: 250,
      total: 1000,
      remainingPercentage: 75,
    });
  });

  it("adds weekly quota rows without changing paid-tier family rollups", async () => {
    mockUsage({
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 0.5, resetTime: "2026-09-10T00:00:00Z" },
        },
      },
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 50,
      family: "gemini",
    });
    expect(usage.quotas.gemini_weekly).toMatchObject({
      remainingPercentage: 75,
      displayName: "Gemini (Weekly)",
    });
    expect(usage.quotas.claude_gpt_weekly).toMatchObject({
      remainingPercentage: 50,
      displayName: "Claude & GPT (Weekly)",
    });
  });

  it("forces misleading available weekly quotas to zero when families are exhausted", async () => {
    mockUsage({
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { resetTime: "2026-09-13T12:00:00Z" },
        },
        "claude-sonnet-4-6": {
          quotaInfo: { resetTime: "2026-09-14T12:00:00Z" },
        },
        "claude-opus-4-6-thinking": {
          quotaInfo: { resetTime: "2026-09-15T12:00:00Z" },
        },
      },
      weekly: weeklySummary(1, "2026-09-20T00:00:00Z", 1, "2026-09-21T00:00:00Z"),
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"].remainingPercentage).toBe(0);
    expect(usage.quotas.gemini_weekly).toMatchObject({
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-09-13T12:00:00.000Z",
    });
    expect(usage.quotas.claude_gpt_weekly).toMatchObject({
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-09-15T12:00:00.000Z",
    });
  });

  it("forces family rollups to zero when weekly quota is exhausted and validates isFamilyRollup", async () => {
    const { isFamilyRollup, parseQuotaData } = await import("@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
    mockUsage({
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 0.9, resetTime: "2026-09-13T12:00:00Z" },
        },
      },
      weekly: weeklySummary(0, "2026-09-25T00:00:00Z", 0, "2026-09-26T00:00:00Z"),
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["Gemini (all models)"].remainingPercentage).toBe(0);
    expect(usage.quotas["Gemini (all models)"].resetAt).toBe("2026-09-25T00:00:00.000Z");
    expect(usage.quotas["gemini-3.8-flash-high"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-3.8-flash-high"].resetAt).toBe("2026-09-25T00:00:00.000Z");
    expect(usage.quotas.gemini_weekly.remainingPercentage).toBe(0);

    const parsed = parseQuotaData("antigravity", usage);
    const weeklyItem = parsed.find((p) => p.name === "Gemini (Weekly)");
    expect(weeklyItem).toBeDefined();
    expect(isFamilyRollup(weeklyItem)).toBe(true);
  });
});
