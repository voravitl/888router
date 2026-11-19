import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectionWrites = [];
const mockConnections = new Map();

const mocks = vi.hoisted(() => ({
  getAntigravityUsage: vi.fn(async () => ({ quotas: {} })),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ providerStrategies: {}, fallbackStrategy: "fill-first" })),
  getProviderConnections: vi.fn(async ({ provider } = {}) =>
    [...mockConnections.values()].filter((c) => !provider || c.provider === provider)
  ),
  getProviderConnectionById: vi.fn(async (id) => mockConnections.get(id) || null),
  updateProviderConnection: vi.fn(async (id, data) => {
    connectionWrites.push({ id, ...data });
    const existing = mockConnections.get(id) || { id };
    const updated = { ...existing, ...data };
    for (const [k, v] of Object.entries(data)) {
      if (v === null) delete updated[k];
    }
    mockConnections.set(id, updated);
    return updated;
  }),
  validateApiKey: vi.fn(async () => ({ valid: false })),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    vercelRelayUrl: "",
    strictProxy: false,
  })),
}));

vi.mock("@/lib/db/repos/proxyPoolsRepo", () => ({
  getProxyPools: vi.fn(async () => []),
  getProxyPoolById: vi.fn(async () => null),
  updateProxyPool: vi.fn(async () => null),
}));

vi.mock("open-sse/services/quotaSnapshot.js", () => ({
  partitionByQuotaHealth: vi.fn((conns) => ({ healthy: conns })),
  QUOTA_AVOID_THRESHOLD_PCT: 0.9,
  QUOTA_SNAPSHOT_MAX_AGE_MS: 60_000,
}));

vi.mock("open-sse/services/accountScoring.js", () => ({
  pickByScore: vi.fn((pool) => ({ connection: pool[0], breakdown: { reason: "mock" } })),
}));

vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mocks.proxyAwareFetch(...args),
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
const {
  handleProviderQuotaError,
  clearProviderStrikes,
  isPairBlocked,
  __resetProviderQuotaCache,
} = await import("../../src/sse/services/providerQuota.js");
const { markAccountUnavailable, getProviderCredentials } = await import("../../src/sse/services/auth.js");
const {
  ANTIGRAVITY_429_MIN_COOLDOWN_MS,
  ACCOUNT_VALIDATION_PARK_MS,
  BACKOFF_CONFIG,
} = await import("../../open-sse/config/errorConfig.js");

function mockResponse(status, body = null, headers = {}) {
  const bodyStr = body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => bodyStr }),
    text: async () => bodyStr,
  };
}

const HOUR = 3600_000;
const CONN = "ag-conn-429";

describe("Antigravity 429 & Quota Hardening", () => {
  beforeEach(() => {
    __resetProviderQuotaCache();
    connectionWrites.length = 0;
    mockConnections.clear();
    mocks.getAntigravityUsage.mockReset().mockResolvedValue({ quotas: {} });
    mocks.proxyAwareFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("1. AntigravityExecutor.computeRetryDelay 429 veto & blind backoff cap", () => {
    const ag = new AntigravityExecutor();

    it("vetoes retry immediately (false) on bare 429 RESOURCE_EXHAUSTED with check quota and no Retry-After", async () => {
      const r = mockResponse(429, {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
        },
      });
      expect(await ag.computeRetryDelay(r, 1)).toBe(false);
    });

    it("vetoes retry immediately on plain-text quota exhaustion 429 without Retry-After", async () => {
      const r1 = mockResponse(429, "Resource has been exhausted (e.g. check quota).");
      const r2 = mockResponse(429, { error: { message: "Quota exceeded for model" } });
      const r3 = mockResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } });
      expect(await ag.computeRetryDelay(r1, 1)).toBe(false);
      expect(await ag.computeRetryDelay(r2, 1)).toBe(false);
      expect(await ag.computeRetryDelay(r3, 1)).toBe(false);
    });

    it("keeps bounded transient retries for RESOURCE_EXHAUSTED capacity / high-traffic 429s (not a quota wall)", async () => {
      const capacity = () => mockResponse(429, {
        error: {
          code: 429,
          message: "No capacity available for model gemini-4-hydrogen on the server",
          status: "RESOURCE_EXHAUSTED",
        },
      });
      const traffic = () => mockResponse(429, {
        error: { message: "Our servers are experiencing high traffic. Quota check pending.", status: "RESOURCE_EXHAUSTED" },
      });
      expect(await ag.computeRetryDelay(capacity(), 1)).toBe(2000);
      expect(await ag.computeRetryDelay(capacity(), 2)).toBe(4000);
      expect(await ag.computeRetryDelay(capacity(), 3)).toBe(8000);
      expect(await ag.computeRetryDelay(capacity(), 4)).toBe(false);
      expect(await ag.computeRetryDelay(traffic(), 1)).toBe(2000);
      // genuine quota wall still vetoes immediately
      expect(await ag.computeRetryDelay(mockResponse(429, {
        error: { message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
      }), 1)).toBe(false);
    });

    it("preserves explicit short retry delay even when body mentions quota or RESOURCE_EXHAUSTED", async () => {
      const rHeader = mockResponse(
        429,
        { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } },
        { "retry-after": "5" }
      );
      const rBody = mockResponse(429, {
        error: { message: "Your quota will reset after 3s", status: "RESOURCE_EXHAUSTED" },
      });
      expect(await ag.computeRetryDelay(rHeader, 1)).toBe(5000);
      expect(await ag.computeRetryDelay(rBody, 1)).toBe(3000);
    });

    it("preserves attempt 1..3 backoff (2000/4000/8000) on bare bodyless 429 and caps attempt > 3", async () => {
      expect(await ag.computeRetryDelay(mockResponse(429), 1)).toBe(2000);
      expect(await ag.computeRetryDelay(mockResponse(429), 2)).toBe(4000);
      expect(await ag.computeRetryDelay(mockResponse(429), 3)).toBe(8000);
      expect(await ag.computeRetryDelay(mockResponse(429), 4)).toBe(false);
      expect(await ag.computeRetryDelay(mockResponse(429), 5)).toBe(false);
      expect(await ag.computeRetryDelay(mockResponse(429), 6)).toBe(false);
    });

    it("execute() makes only 1 upstream hit on bare 429 RESOURCE_EXHAUSTED (0 retries)", async () => {
      mocks.proxyAwareFetch.mockResolvedValue(
        mockResponse(429, {
          error: {
            code: 429,
            message: "Resource has been exhausted (e.g. check quota).",
            status: "RESOURCE_EXHAUSTED",
          },
        })
      );

      const out = await ag.execute({
        model: "gemini-4-hydrogen",
        body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
        stream: false,
        credentials: { accessToken: "tok", projectId: "proj-1" },
      });

      expect(out.response.status).toBe(429);
      expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    });

    it("execute() makes at most 4 upstream hits (1 initial + 3 retries) on bare bodyless 429", async () => {
      vi.useFakeTimers();
      mocks.proxyAwareFetch.mockImplementation(async () => mockResponse(429));

      const promise = ag.execute({
        model: "gemini-4-hydrogen",
        body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
        stream: false,
        credentials: { accessToken: "tok", projectId: "proj-1" },
      });

      await vi.runAllTimersAsync();
      const out = await promise;

      expect(out.response.status).toBe(429);
      expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe("2. providerQuota model alias normalization & lookup", () => {
    it("resolves gemini-4-hydrogen-tiered-xhigh to gemini-4-hydrogen-xhigh quota & resetAt", async () => {
      const resetAt = new Date(Date.now() + 80 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValueOnce({
        quotas: {
          "gemini-4-hydrogen-xhigh": { remainingPercentage: 0, resetAt },
        },
      });

      const resetMs = await handleProviderQuotaError(
        "antigravity",
        CONN,
        429,
        "gemini-4-hydrogen-tiered-xhigh",
        "tok",
        {}
      );

      expect(resetMs).toBe(new Date(resetAt).getTime());
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen-tiered-xhigh")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen(xhigh)")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen-xhigh")).toBe(resetMs);
    });

    it("resolves gemini-4-hydrogen(xhigh) to bare gemini-4-hydrogen quota when tier-specific key is absent", async () => {
      const resetAt = new Date(Date.now() + 5 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValueOnce({
        quotas: {
          "gemini-4-hydrogen": { remainingPercentage: 0, resetAt },
        },
      });

      const resetMs = await handleProviderQuotaError(
        "antigravity",
        CONN,
        429,
        "gemini-4-hydrogen(xhigh)",
        "tok",
        {}
      );

      expect(resetMs).toBe(new Date(resetAt).getTime());
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen(xhigh)")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen-tiered-xhigh")).toBe(resetMs);
    });

    it("prefers exact / tier-specific key over bare base key when both exist", async () => {
      const xhighReset = new Date(Date.now() + 12 * HOUR).toISOString();
      const baseReset = new Date(Date.now() + 1 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-hydrogen-xhigh": { remainingPercentage: 0, resetAt: xhighReset },
          "gemini-4-hydrogen": { remainingPercentage: 60, resetAt: baseReset },
        },
      });

      const resetMs = await handleProviderQuotaError(
        "antigravity",
        CONN,
        429,
        "gemini-4-hydrogen-tiered-xhigh",
        "tok",
        {}
      );
      expect(resetMs).toBe(new Date(xhighReset).getTime());

      // Bare gemini-4-hydrogen still reads its own 60% entry (strike 1 -> null)
      const baseRes = await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen", "tok", {});
      expect(baseRes).toBeNull();
    });

    it("resolves gemini-4-argon-high(high) and gemini-3.8-flash-tiered-high without cross-tier pollution", async () => {
      const resetAt = new Date(Date.now() + 2 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-argon-high": { remainingPercentage: 0, resetAt },
          "gemini-3.8-flash-high": { remainingPercentage: 0, resetAt },
        },
      });

      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-argon-high(high)", "tok", {}))
        .toBe(new Date(resetAt).getTime());
      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-3.8-flash-tiered-high", "tok", {}))
        .toBe(new Date(resetAt).getTime());
      expect(isPairBlocked("antigravity", CONN, "gemini-4-argon-low")).toBeNull();
    });

    it("coalesces optimistic strikes across Hydrogen aliases and clears cleanly on success", async () => {
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-hydrogen-xhigh": { remainingPercentage: 10, resetAt: new Date(Date.now() + HOUR).toISOString() },
        },
      });

      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen-tiered-xhigh", "tok", {})).toBeNull();
      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen(xhigh)", "tok", {})).toBeNull();
      const blockedUntil = await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen-xhigh", "tok", {});
      expect(blockedUntil).not.toBeNull();
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen-tiered-xhigh")).toBe(blockedUntil);

      clearProviderStrikes("antigravity", CONN, "gemini-4-hydrogen(xhigh)");
      expect(isPairBlocked("antigravity", CONN, "gemini-4-hydrogen-tiered-xhigh")).toBeNull();
    });

    it("handles null, empty, and prototype-property model names safely", async () => {
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-hydrogen": { remainingPercentage: 0, resetAt: new Date(Date.now() + HOUR).toISOString() },
        },
      });
      await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen", "tok", {});

      expect(isPairBlocked("antigravity", CONN, null)).toBeNull();
      expect(isPairBlocked("antigravity", CONN, "")).toBeNull();
      expect(isPairBlocked("antigravity", CONN, "toString")).toBeNull();
      expect(isPairBlocked("antigravity", CONN, "constructor")).toBeNull();
    });

    it("integrates with getProviderCredentials pre-filter for aliased model names", async () => {
      const resetAt = new Date(Date.now() + 80 * HOUR).toISOString();
      mockConnections.set(CONN, {
        id: CONN,
        provider: "antigravity",
        isActive: true,
        testStatus: "active",
        accessToken: "tok",
        providerSpecificData: {},
      });
      mocks.getAntigravityUsage.mockResolvedValueOnce({
        quotas: {
          "gemini-4-hydrogen-xhigh": { remainingPercentage: 0, resetAt },
        },
      });

      await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-hydrogen-tiered-xhigh", "tok", {});
      const creds = await getProviderCredentials("antigravity", null, "gemini-4-hydrogen-tiered-xhigh");
      expect(creds?.allRateLimited).toBe(true);
      expect(creds?.retryAfter).toBe(resetAt);
    });

    it("resolves gemini-4-neon-tiered-xhigh to gemini-4-neon-xhigh quota & resetAt", async () => {
      const resetAt = new Date(Date.now() + 80 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValueOnce({
        quotas: {
          "gemini-4-neon-xhigh": { remainingPercentage: 0, resetAt },
        },
      });

      const resetMs = await handleProviderQuotaError(
        "antigravity",
        CONN,
        429,
        "gemini-4-neon-tiered-xhigh",
        "tok",
        {}
      );

      expect(resetMs).toBe(new Date(resetAt).getTime());
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon-tiered-xhigh")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon(xhigh)")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon-xhigh")).toBe(resetMs);
    });

    it("resolves bare gemini-4-neon and gemini-4-neon-tiered against gemini-4-neon-high quota key without crossing xhigh", async () => {
      const resetAt = new Date(Date.now() + 5 * HOUR).toISOString();
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-neon-high": { remainingPercentage: 0, resetAt },
        },
      });

      const resetMs = await handleProviderQuotaError(
        "antigravity",
        CONN,
        429,
        "gemini-4-neon",
        "tok",
        {}
      );

      expect(resetMs).toBe(new Date(resetAt).getTime());
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon-tiered")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon(high)")).toBe(resetMs);
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon(xhigh)")).toBeNull();
    });

    it("coalesces optimistic strikes across Neon aliases and clears cleanly on success", async () => {
      mocks.getAntigravityUsage.mockResolvedValue({
        quotas: {
          "gemini-4-neon-xhigh": { remainingPercentage: 10, resetAt: new Date(Date.now() + HOUR).toISOString() },
        },
      });

      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-neon-tiered-xhigh", "tok", {})).toBeNull();
      expect(await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-neon(xhigh)", "tok", {})).toBeNull();
      const blockedUntil = await handleProviderQuotaError("antigravity", CONN, 429, "gemini-4-neon-xhigh", "tok", {});
      expect(blockedUntil).not.toBeNull();
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon-tiered-xhigh")).toBe(blockedUntil);

      clearProviderStrikes("antigravity", CONN, "gemini-4-neon(xhigh)");
      expect(isPairBlocked("antigravity", CONN, "gemini-4-neon-tiered-xhigh")).toBeNull();
    });
  });

  describe("3. markAccountUnavailable Antigravity 429 minimum cooldown floor", () => {
    it("locks antigravity 429 without resetsAtMs for >= ANTIGRAVITY_429_MIN_COOLDOWN_MS (60s) instead of 2s", async () => {
      expect(ANTIGRAVITY_429_MIN_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);

      mockConnections.set("ag-bare-429", {
        id: "ag-bare-429",
        provider: "antigravity",
        isActive: true,
        backoffLevel: 0,
      });

      const before = Date.now();
      const res = await markAccountUnavailable(
        "ag-bare-429",
        429,
        "Resource has been exhausted (e.g. check quota).",
        "antigravity",
        "gemini-4-hydrogen-tiered-xhigh"
      );

      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBeGreaterThanOrEqual(60_000);
      const updated = mockConnections.get("ag-bare-429");
      expect(new Date(updated.modelLock___all).getTime()).toBeGreaterThanOrEqual(before + 60_000 - 1000);
      expect(updated.backoffLevel).toBe(1);
    });

    it("also applies >= 60s floor when provider alias 'ag' is passed", async () => {
      mockConnections.set("ag-alias-429", {
        id: "ag-alias-429",
        provider: "antigravity",
        isActive: true,
        backoffLevel: 0,
      });

      const res = await markAccountUnavailable("ag-alias-429", 429, "Rate limit exceeded", "ag", "gemini-4-hydrogen");
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBeGreaterThanOrEqual(60_000);
    });

    it("still escalates above 60s when backoffLevel increases", async () => {
      mockConnections.set("ag-esc", {
        id: "ag-esc",
        provider: "antigravity",
        isActive: true,
        backoffLevel: 5, // newLevel = 6 -> 2000 * 2^5 = 64_000
      });

      const res = await markAccountUnavailable(
        "ag-esc",
        429,
        "Resource has been exhausted (e.g. check quota).",
        "antigravity",
        "gemini-4-hydrogen"
      );

      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(64_000);
      expect(mockConnections.get("ag-esc").backoffLevel).toBe(6);
    });

    it("respects explicit future resetsAtMs and falls back to >= 60s when resetsAtMs is null or in the past", async () => {
      mockConnections.set("ag-explicit", { id: "ag-explicit", provider: "antigravity", isActive: true, backoffLevel: 0 });
      const futureRes = await markAccountUnavailable(
        "ag-explicit",
        429,
        "Quota will reset after 10s",
        "antigravity",
        "gemini-4-hydrogen",
        Date.now() + 10_000
      );
      expect(futureRes.cooldownMs).toBeGreaterThan(8_000);
      expect(futureRes.cooldownMs).toBeLessThanOrEqual(10_500);

      mockConnections.set("ag-past", { id: "ag-past", provider: "antigravity", isActive: true, backoffLevel: 0 });
      const pastRes = await markAccountUnavailable(
        "ag-past",
        429,
        "Resource has been exhausted (e.g. check quota).",
        "antigravity",
        "gemini-4-hydrogen",
        Date.now() - 1_000
      );
      expect(pastRes.cooldownMs).toBeGreaterThanOrEqual(60_000);
    });

    it("preserves long VALIDATION_REQUIRED quarantine on 429 for antigravity", async () => {
      mockConnections.set("ag-val-429", { id: "ag-val-429", provider: "antigravity", isActive: true, backoffLevel: 0 });
      const res = await markAccountUnavailable(
        "ag-val-429",
        429,
        "VALIDATION_REQUIRED: Verify your account",
        "antigravity",
        "gemini-4-hydrogen"
      );
      expect(res.cooldownMs).toBeGreaterThanOrEqual(ACCOUNT_VALIDATION_PARK_MS);
    });

    it("keeps non-antigravity providers at BACKOFF_CONFIG.base (2s) on first 429", async () => {
      mockConnections.set("oa-429", { id: "oa-429", provider: "openai", isActive: true, backoffLevel: 0 });
      const res = await markAccountUnavailable("oa-429", 429, "Rate limit exceeded", "openai", "gpt-5");
      expect(res.shouldFallback).toBe(true);
      expect(res.cooldownMs).toBe(BACKOFF_CONFIG.base);
    });
  });
});
