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
});
