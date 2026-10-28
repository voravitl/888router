import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ row: null, refresh: vi.fn(), write: vi.fn(), events: [] }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => [structuredClone(state.row)],
  getCombos: async () => [], getCustomModels: async () => [], getModelAliases: async () => ({}),
  updateProviderConnection: (...args) => state.write(...args),
}));
vi.mock("@/lib/db", () => ({ getAllModelDynamicCapabilities: async () => new Map() }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => ({
  ...await importOriginal(),
  refreshTokenByProvider: (...args) => state.refresh(...args),
  refreshKiroToken: (...args) => state.refresh(...args),
}));

import { buildModelsList } from "../../src/app/api/v1/models/route.js";
import { clearKiroModelCache, resolveKiroModels } from "../../open-sse/services/kiroModels.js";

const NOW = new Date("2026-10-28T10:00:00Z");
const profileArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/fixture";
const liveId = "kr/lifecycle-fixture";
const ok = () => new Response(JSON.stringify({ models: [{ modelId: "lifecycle-fixture" }] }));
const denied = (status = 403) => new Response(JSON.stringify({ message: "The bearer token included in the request is invalid.", reason: null }), { status });
const list = () => buildModelsList(["llm"]);
const hasLive = (models) => models.some((m) => m.id === liveId);
const fallback = (models) => {
  expect(hasLive(models)).toBe(false);
  expect(models.some((m) => m.id.startsWith("kr/claude-"))).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  clearKiroModelCache();
  state.events = [];
  state.row = {
    id: "kiro-fixture", provider: "kiro", authType: "oauth", isActive: true,
    accessToken: "old-fixture", refreshToken: "refresh-fixture",
    expiresAt: "2026-10-28T09:00:00Z",
    providerSpecificData: { profileArn, authMethod: "idc", clientId: "fixture-client", clientSecret: "fixture-secret", region: "ap-southeast-1" },
  };
  state.refresh.mockReset().mockImplementation(async () => {
    state.events.push("refresh");
    return { accessToken: "fresh-fixture", refreshToken: "rotated-fixture", expiresIn: 3600, providerSpecificData: { rotationMarker: "new" } };
  });
  state.write.mockReset().mockImplementation(async (id, updates) => {
    state.events.push("persist");
    expect(id).toBe(state.row.id);
    Object.assign(state.row, updates);
    return structuredClone(state.row);
  });
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    state.events.push(options.headers.Authorization);
    return options.headers.Authorization === "Bearer fresh-fixture" ? ok() : denied();
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("real buildModelsList → Kiro resolver → credential persistence", () => {
  it("refreshes expired OAuth before fetch, persists rotation and reuses it on a second DB read", async () => {
    expect(hasLive(await list())).toBe(true);
    expect(state.events).toEqual(["refresh", "persist", "Bearer fresh-fixture"]);
    expect(state.row).toMatchObject({ accessToken: "fresh-fixture", refreshToken: "rotated-fixture", expiresAt: "2026-10-28T11:00:00.000Z", providerSpecificData: { profileArn, clientId: "fixture-client", clientSecret: "fixture-secret", region: "ap-southeast-1", rotationMarker: "new" } });
    clearKiroModelCache(); // Prove persisted credentials, not catalog cache or local mutation.
    expect(hasLive(await list())).toBe(true);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["2026-10-28T12:00:00Z", undefined])("does not proactively refresh fresh/missing-expiry OAuth (%s)", async (expiry) => {
    state.row.expiresAt = expiry;
    fetch.mockResolvedValue(ok());
    expect(hasLive(await list())).toBe(true);
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(["apikey", "apiKey"])("never refreshes explicit API-key credentials (%s), even on 401", async (authType) => {
    state.row.authType = authType;
    fetch.mockImplementation(async () => denied(401));
    fallback(await list());
    expect(state.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never refreshes Kiro API-key authMethod even if refresh metadata remains", async () => {
    state.row.providerSpecificData.authMethod = "api_key";
    fetch.mockImplementation(async () => denied(401));
    fallback(await list());
    expect(state.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not refresh credentials without a refresh token", async () => {
    delete state.row.refreshToken;
    fallback(await list());
    expect(state.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not interpret generic 403 as refresh permission", async () => {
    state.row.expiresAt = "2026-10-28T12:00:00Z";
    fallback(await list());
    expect(state.refresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, { error: "invalid_grant" }])("falls back without stale fetch when proactive refresh returns %j", async (result) => {
    state.refresh.mockResolvedValue(result);
    fallback(await list());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
  });
  it("contains thrown refresh failure in the resolver", async () => {
    state.refresh.mockRejectedValue(new Error("fixture refresh unavailable"));
    expect(await resolveKiroModels(structuredClone(state.row))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, "throw"])("does not fetch/cache or claim repair after persistence failure (%s)", async (result) => {
    state.write.mockImplementation(async () => { if (result === "throw") throw new Error("fixture DB failure"); return false; });
    fallback(await list());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.row.accessToken).toBe("old-fixture");
  });
  it("recovers missing-expiry OAuth on one 401, persisting before retry", async () => {
    delete state.row.expiresAt;
    fetch.mockImplementation(async (_url, options) => {
      state.events.push(options.headers.Authorization);
      return options.headers.Authorization === "Bearer fresh-fixture" ? ok() : denied(401);
    });
    expect(hasLive(await list())).toBe(true);
    expect(state.events).toEqual(["Bearer old-fixture", "refresh", "persist", "Bearer fresh-fixture"]);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
  it("does not refresh twice after proactive refresh is rejected with 401", async () => {
    fetch.mockImplementation(async () => denied(401));
    fallback(await list());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("stops after the single reactive refresh/retry is rejected", async () => {
    delete state.row.expiresAt;
    fetch.mockImplementation(async () => denied(401));
    fallback(await list());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("shares the existing credential refresh lock across concurrent caller requests", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    state.refresh.mockImplementation(async () => { await pending; return { accessToken: "fresh-fixture", expiresIn: 3600 }; });
    const requests = [list(), list()];
    await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
    release();
    for (const models of await Promise.all(requests)) expect(hasLive(models)).toBe(true);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
