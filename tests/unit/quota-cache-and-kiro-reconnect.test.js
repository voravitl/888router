import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Quota cache hydration, Kiro reconnect CTA helper, and /api/models dedup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("hydrates cached quota entries immediately and marks only uncached rows as loading", async () => {
    const { hydrateQuotaCacheForConnections } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );

    const connections = [
      { id: "c1", provider: "codex" },
      { id: "c2", provider: "kiro" },
      { id: "c3", provider: "antigravity" },
      { id: "c4", provider: "claude" },
    ];
    const cache = {
      c1: { quotas: [{ name: "5h", used: 10, total: 100 }], cachedAt: "2026-11-13T10:00:00.000Z" },
      c2: { quotas: [], message: "Kiro quota API is unavailable", cachedAt: "2026-11-13T10:00:00.000Z" },
      c3: { garbage: true }, // unusable cache entry
      staleOther: { quotas: [{ name: "x", used: 0, total: 10 }] },
    };

    const { cachedQuotaData, loadingState } = hydrateQuotaCacheForConnections(cache, connections);

    expect(Object.keys(cachedQuotaData).sort()).toEqual(["c1", "c2"]);
    expect(cachedQuotaData.c1.quotas).toHaveLength(1);
    expect(cachedQuotaData.c2.message).toBe("Kiro quota API is unavailable");
    expect(loadingState).toEqual({
      c3: true,
      c4: true,
    });
  });

  it("identifies Kiro accounts needing Reconnect CTA when IDC/session unavailable or clientSecret expired", async () => {
    const { getKiroReconnectInfo } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );

    const nowMs = Date.parse("2026-11-13T12:00:00.000Z");

    const idcMessageOnly = getKiroReconnectInfo(
      { id: "k1", provider: "kiro", authType: "oauth", testStatus: "active" },
      {
        quotas: [],
        message:
          "Kiro quota API is unavailable for the current AWS IAM Identity Center session. Chat may still work. If this persists after renewing your session, reconnect Kiro.",
      },
      nowMs,
    );
    expect(idcMessageOnly).toMatchObject({
      needsReconnect: true,
      href: "/dashboard/providers/kiro",
      secretExpired: false,
    });

    const expiredSecret = getKiroReconnectInfo(
      {
        id: "k2",
        provider: "kiro",
        authType: "oauth",
        testStatus: "unavailable",
        providerSpecificData: {
          authMethod: "idc",
          clientSecretExpiresAt: "2026-11-12T14:56:06.000Z",
        },
      },
      { quotas: [], message: "Kiro quota API is unavailable" },
      nowMs,
    );
    expect(expiredSecret.needsReconnect).toBe(true);
    expect(expiredSecret.secretExpired).toBe(true);
    expect(expiredSecret.href).toBe("/dashboard/providers/kiro");

    const healthyKiro = getKiroReconnectInfo(
      {
        id: "k3",
        provider: "kiro",
        authType: "oauth",
        testStatus: "active",
        providerSpecificData: {
          authMethod: "builder-id",
          clientSecretExpiresAt: "2027-01-01T00:00:00.000Z",
        },
      },
      { quotas: [{ name: "credits", used: 10, total: 500 }] },
      nowMs,
    );
    expect(healthyKiro.needsReconnect).toBe(false);
    expect(healthyKiro.secretExpired).toBe(false);

    const nonKiro = getKiroReconnectInfo(
      { id: "g1", provider: "codex", authType: "oauth", testStatus: "expired" },
      { quotas: [], message: "Token expired" },
      nowMs,
    );
    expect(nonKiro.needsReconnect).toBe(false);
  });

  it("deduplicates concurrent /api/models fetches across useModelContextWindows and combos loadModelsPayload", async () => {
    const models = [
      { fullModel: "cx/gpt-5.4", caps: { contextWindow: 400000, supportsThinking: true } },
      { id: "km/kimi-k2", caps: { contextWindow: 128000 } },
    ];

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models }),
    });

    const { loadModelsPayload, resetModelsPayloadCacheForTest } = await import(
      "@/shared/hooks/useModelContextWindows.js"
    );
    resetModelsPayloadCacheForTest();

    const [p1, p2] = await Promise.all([loadModelsPayload(), loadModelsPayload()]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(p1.contextByFullModel["cx/gpt-5.4"]).toBe(400000);
    expect(p1.capsByFullModel["cx/gpt-5.4"]).toEqual({ contextWindow: 400000, supportsThinking: true });
    expect(p2.contextByFullModel["km/kimi-k2"]).toBe(128000);
  });

  it("isFamilyRollup accepts gemini_argon and rejects malformed gemini_argon rollups", async () => {
    const { isFamilyRollup } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );

    expect(isFamilyRollup({ family: "gemini_argon", familyKey: "gemini_argon", memberCount: 2 })).toBe(true);
    expect(isFamilyRollup({ family: "gemini_argon", familyKey: "gemini_argon", memberCount: 1, isWeekly: true })).toBe(true);
    expect(isFamilyRollup({ family: "gemini_argon", familyKey: "gemini", memberCount: 2 })).toBe(false);
    expect(isFamilyRollup({ family: "gemini_argon", familyKey: "gemini_argon", memberCount: 0 })).toBe(false);
    expect(isFamilyRollup({ family: "gemini_argon", familyKey: "gemini_argon" })).toBe(false);
  });

  it("parseQuotaData('antigravity') preserves isWeekly only on weekly rows and forwards Argon rollup metadata", async () => {
    const { isFamilyRollup, parseQuotaData } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );

    const parsed = parseQuotaData("antigravity", {
      quotas: {
        "gemini-4-argon-high": {
          used: 750,
          total: 1000,
          resetAt: "2026-11-14T12:00:00.000Z",
          remainingPercentage: 25,
          displayName: "Gemini 4 Argon (High)",
        },
        "Gemini 4 Argon (all models)": {
          used: 750,
          total: 1000,
          resetAt: "2026-11-14T12:00:00.000Z",
          remainingPercentage: 25,
          displayName: "Gemini 4 Argon (all models)",
          family: "gemini_argon",
          familyKey: "gemini_argon",
          memberCount: 2,
        },
        gemini_argon_weekly: {
          used: 400,
          total: 1000,
          resetAt: "2026-11-20T00:00:00.000Z",
          remainingPercentage: 60,
          displayName: "Gemini 4 Argon (Weekly)",
          family: "gemini_argon",
          familyKey: "gemini_argon",
          memberCount: 1,
          isWeekly: true,
        },
        gemini_weekly: {
          used: 200,
          total: 1000,
          resetAt: "2026-11-20T00:00:00.000Z",
          remainingPercentage: 80,
          displayName: "Gemini (Weekly)",
          family: "gemini",
          familyKey: "gemini",
          memberCount: 1,
          isWeekly: true,
        },
      },
    });

    const byName = Object.fromEntries(parsed.map((row) => [row.name, row]));

    expect(byName["Gemini 4 Argon (all models)"]).toMatchObject({
      family: "gemini_argon",
      familyKey: "gemini_argon",
      memberCount: 2,
      displayName: "Gemini 4 Argon (all models)",
    });
    expect(byName["Gemini 4 Argon (all models)"].isWeekly).toBeUndefined();
    expect(isFamilyRollup(byName["Gemini 4 Argon (all models)"])).toBe(true);

    expect(byName["Gemini 4 Argon (Weekly)"].isWeekly).toBe(true);
    expect(isFamilyRollup(byName["Gemini 4 Argon (Weekly)"])).toBe(true);

    expect(byName["Gemini (Weekly)"].isWeekly).toBe(true);
    expect(isFamilyRollup(byName["Gemini (Weekly)"])).toBe(true);

    expect(byName["Gemini 4 Argon (High)"].isWeekly).toBeUndefined();
    expect(isFamilyRollup(byName["Gemini 4 Argon (High)"])).toBe(false);
  });

  it("google.js emits Gemini 4 Argon (all models) rollup and zeroes it when weekly Argon quota is exhausted", async () => {
    let weeklyArgonRemaining = 0.6;
    const proxyAwareFetch = vi.fn(async (url) => {
      if (url.includes(":loadCodeAssist")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cloudaicompanionProject: "project-1",
            currentTier: { name: "Pro" },
            paidTier: { id: "pro-tier" },
          }),
        };
      }
      if (url.includes(":fetchAvailableModels")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: {
              "gemini-3.8-flash-high": {
                displayName: "Gemini 3.8 Flash (High)",
                quotaInfo: { remainingFraction: 0.85, resetTime: "2026-11-14T12:00:00Z" },
              },
              "gemini-4-argon-high": {
                displayName: "Gemini 4 Argon (High)",
                quotaInfo: { remainingFraction: 0.7, resetTime: "2026-11-14T14:00:00Z" },
              },
              "gemini-4-argon-low": {
                displayName: "Gemini 4 Argon (Low)",
                quotaInfo: { remainingFraction: 0.3, resetTime: "2026-11-14T11:00:00Z" },
              },
              "claude-sonnet-5-5-high": {
                displayName: "Claude Sonnet 5.5 (High)",
                quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-14T15:00:00Z" },
              },
            },
          }),
        };
      }
      if (url.includes(":retrieveUserQuotaSummary")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [{
                  bucketId: "gemini-weekly",
                  displayName: "Weekly Limit",
                  remainingFraction: 0.75,
                  resetTime: "2026-11-20T00:00:00Z",
                }],
              },
              {
                displayName: "Gemini 4 Argon",
                buckets: [{
                  bucketId: "gemini-argon-wtu-weekly",
                  displayName: "Gemini 4 Argon Weekly Limit",
                  remainingFraction: weeklyArgonRemaining,
                  resetTime: "2026-11-21T00:00:00Z",
                }],
              },
              {
                displayName: "Claude and GPT models",
                buckets: [{
                  bucketId: "claude-gpt-weekly",
                  displayName: "Weekly Limit",
                  remainingFraction: 0.5,
                  resetTime: "2026-11-22T00:00:00Z",
                }],
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch,
    }));

    const { _clearWeeklyCache } = await import("../../open-sse/services/usage/antigravity-weekly.js");
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const { isFamilyRollup, parseQuotaData } = await import(
      "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js"
    );

    _clearWeeklyCache();
    const healthyUsage = await getAntigravityUsage("token-healthy", {});

    expect(healthyUsage.quotas["Gemini 4 Argon (all models)"]).toMatchObject({
      used: 700,
      total: 1000,
      remainingPercentage: 30,
      displayName: "Gemini 4 Argon (all models)",
      family: "gemini_argon",
      familyKey: "gemini_argon",
      memberCount: 2,
      resetAt: "2026-11-14T11:00:00.000Z",
    });
    expect(healthyUsage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 85,
      family: "gemini",
      memberCount: 1,
    });

    const parsedHealthy = parseQuotaData("antigravity", healthyUsage);
    const rollupNames = parsedHealthy.filter(isFamilyRollup).map((r) => r.name);
    expect(rollupNames).toEqual(
      expect.arrayContaining([
        "Gemini (all models)",
        "Gemini (Weekly)",
        "Gemini 4 Argon (all models)",
        "Gemini 4 Argon (Weekly)",
        "Claude (all models)",
        "Claude & GPT (Weekly)",
      ]),
    );
    expect(parsedHealthy.find((r) => r.name === "Gemini 4 Argon (Weekly)")?.isWeekly).toBe(true);

    // Now test exhausted weekly Argon quota zeroes out the Argon family rollup too
    weeklyArgonRemaining = 0;
    _clearWeeklyCache();
    const exhaustedUsage = await getAntigravityUsage("token-exhausted", {});

    expect(exhaustedUsage.quotas["Gemini 4 Argon (all models)"]).toMatchObject({
      used: 1000,
      total: 1000,
      remainingPercentage: 0,
      resetAt: "2026-11-21T00:00:00.000Z",
    });
    expect(exhaustedUsage.quotas["gemini-4-argon-high"].remainingPercentage).toBe(0);
    expect(exhaustedUsage.quotas["gemini-4-argon-low"].remainingPercentage).toBe(0);
    expect(exhaustedUsage.quotas["Gemini (all models)"].remainingPercentage).toBe(85);

    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});
