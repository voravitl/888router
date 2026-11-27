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

  it("parses per-model quotas when the API omits paidTierId and tier name (no free tier exists)", async () => {
    // Antigravity has no free tier (repo owner, 2026-09-29), so a missing
    // paidTierId means the API shape changed — it must be treated as PAID and
    // the per-model quotas parsed. The previous detection added
    // `(!paidTierId && ... || !tierName)`, which misclassified exactly this
    // shape as free and silently discarded every per-model row, degrading the
    // quota cache to strike-only blocking instead of the real reset window.
    proxyAwareFetch.mockImplementation(async (url) => {
      if (url.includes(":loadCodeAssist")) {
        return {
          ok: true, status: 200,
          json: async () => ({ cloudaicompanionProject: "project-1" }),
        };
      }
      if (url.includes(":fetchAvailableModels")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            models: {
              "gemini-3.8-flash-high": {
                quotaInfo: { remainingFraction: 1, resetTime: "2026-09-10T00:00:00Z" },
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.8-flash-high"]).toBeDefined();
    expect(usage.quotas["Gemini (all models)"]).toBeDefined();
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
        "claude-sonnet-5-5-high": {
          quotaInfo: { resetTime: "2026-09-14T12:00:00Z" },
        },
        "claude-opus-5-5-medium": {
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

  it("pools Gemini 4 Argon into Gemini weekly quota and ignores legacy Gemini 4 Argon weekly group", async () => {
    mockUsage({
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-09-13T12:00:00Z" },
        },
        "gemini-4-argon-high": {
          quotaInfo: { resetTime: "2026-09-14T12:00:00Z" },
        },
      },
      weekly: {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [{
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit Remaining",
              remainingFraction: 0.47,
              resetTime: "2026-09-20T00:00:00Z",
            }],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [{
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              remainingFraction: 0,
              resetTime: "2026-09-21T00:00:00Z",
            }],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [{
              bucketId: "gemini-argon-wtu-weekly",
              displayName: "Gemini 4 Argon Weekly Limit",
              remainingFraction: 0,
              resetTime: "2026-09-22T00:00:00Z",
            }],
          },
        ],
      },
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    // Gemini weekly quota must NOT be overwritten by a legacy Argon group's 0%
    expect(usage.quotas.gemini_weekly).toMatchObject({
      remainingPercentage: 47,
      displayName: "Gemini (Weekly)",
      resetAt: "2026-09-20T00:00:00.000Z",
    });

    // Legacy Argon weekly/family rows must not be emitted
    expect(usage.quotas.gemini_argon_weekly).toBeUndefined();
    expect(usage.quotas["Gemini 4 Argon (all models)"]).toBeUndefined();

    // Gemini 3.8 Flash remains available per-model (60%)
    expect(usage.quotas["gemini-3.8-flash-high"]).toMatchObject({
      remainingPercentage: 60,
    });

    // Gemini (all models) family rollup reflects min across pooled Gemini models (min(60%, 0%) = 0%)
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 0,
      memberCount: 2,
    });

    // Argon model retains its 0% reading
    expect(usage.quotas["gemini-4-argon-high"]).toMatchObject({
      remainingPercentage: 0,
    });
  });

  it("zeroes Gemini 4 Argon alongside all other Gemini models when gemini_weekly is exhausted", async () => {
    mockUsage({
      models: {
        "gemini-3.8-flash-high": {
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-09-13T12:00:00Z" },
        },
        "gemini-4-argon-high": {
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-09-14T12:00:00Z" },
        },
      },
      weekly: weeklySummary(0, "2026-09-20T00:00:00Z", 0.5, "2026-09-21T00:00:00Z"),
    });

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["Gemini (all models)"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-3.8-flash-high"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-4-argon-high"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-4-argon-high"].resetAt).toBe("2026-09-20T00:00:00.000Z");
  });

  it("parseWeeklyQuotaSummary handles null/missing groups, empty/disabled/5h buckets, and ignores legacy Argon group", async () => {
    const { parseWeeklyQuotaSummary } = await import("../../open-sse/services/usage/antigravity-weekly.js");

    expect(parseWeeklyQuotaSummary(null)).toEqual({});
    expect(parseWeeklyQuotaSummary({})).toEqual({});
    expect(parseWeeklyQuotaSummary({ groups: [{ displayName: "Gemini Models", buckets: [] }] })).toEqual({});
    expect(parseWeeklyQuotaSummary({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remainingFraction: 0.44, resetTime: "2026-11-27T04:18:07Z" },
            { bucketId: "gemini-weekly-disabled", displayName: "Weekly Limit", disabled: true, remainingFraction: 0.1, resetTime: "2026-12-03T08:18:07Z" },
            { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", remainingFraction: 0.25, resetTime: "2026-12-03T08:18:07Z" },
          ],
        },
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            { bucketId: "gemini-argon-wtu-weekly", displayName: "Gemini 4 Argon Weekly Limit", remainingFraction: 0, resetTime: "2026-12-03T08:18:07Z" },
          ],
        },
      ],
    })).toEqual({
      gemini_weekly: {
        used: 750,
        total: 1000,
        resetAt: "2026-12-03T08:18:07.000Z",
        remainingPercentage: 25,
        unlimited: false,
        displayName: "Gemini (Weekly)",
        family: "gemini",
        familyKey: "gemini",
        memberCount: 1,
        isWeekly: true,
      },
    });
  });
});
