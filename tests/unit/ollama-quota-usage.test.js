import { describe, it, expect, vi, afterEach } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// ─── mock proxyAwareFetch before importing misc.js ────────────────────────────
const mockFetch = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

const { getOllamaUsage, calculateNextMonthlyReset } = await import("open-sse/services/usage/misc.js");

// Ollama /api/usage response: limits.monthly.usage is a FRACTION (0–1), NOT USD
function makeUsageRes(fraction = 0.315) {
  return {
    ok: true, status: 200,
    json: async () => ({
      activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
      limits: { monthly: { usage: fraction, models: [] } },
    }),
    text: async () => "",
  };
}

// Ollama /api/me POST response
function makeMeRes(plan = "pro") {
  return {
    ok: true, status: 200,
    json: async () => ({
      ID: "d1585db9-9f11-48bb-9402-20bf94f7dcd9",
      Email: "user@example.com",
      Plan: plan,
    }),
    text: async () => "",
  };
}

function makeAuthErr(status = 401) {
  return { ok: false, status, json: async () => ({}), text: async () => "" };
}

// mockFetch is called for both /api/usage (GET) and /api/me (POST) in parallel
function mockBoth(usageRes, meRes) {
  mockFetch.mockImplementation((url, opts) => {
    if (url.includes("/api/me")) return Promise.resolve(meRes);
    return Promise.resolve(usageRes);
  });
}

describe("calculateNextMonthlyReset", () => {
  it("calculates current month when today is before reset day", () => {
    const fromDate = new Date(Date.UTC(2026, 8, 3)); // Sept 3, 2026
    const reset = calculateNextMonthlyReset(17, fromDate);
    expect(reset.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("calculates next month when today is on or after reset day", () => {
    const fromDate = new Date(Date.UTC(2026, 8, 17)); // Sept 17, 2026
    const reset = calculateNextMonthlyReset(17, fromDate);
    expect(reset.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });

  it("rolls over to next year in December", () => {
    const fromDate = new Date(Date.UTC(2026, 11, 20)); // Dec 20, 2026
    const reset = calculateNextMonthlyReset(17, fromDate);
    expect(reset.toISOString()).toBe("2027-01-17T00:00:00.000Z");
  });

  it("clamps to 30 days in April for resetDay 31", () => {
    const fromDate = new Date(Date.UTC(2026, 2, 20)); // March 20, 2026
    const reset = calculateNextMonthlyReset(31, fromDate);
    expect(reset.toISOString()).toBe("2026-03-31T00:00:00.000Z");

    const fromApril = new Date(Date.UTC(2026, 3, 1)); // April 1, 2026
    const resetApril = calculateNextMonthlyReset(31, fromApril);
    expect(resetApril.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("handles short months in current month (e.g. Feb 28 when resetDay is 31)", () => {
    // Feb 28 in non-leap year: effective reset is Feb 28. On Feb 28, it advances to March 31.
    const onFeb28 = new Date(Date.UTC(2026, 1, 28));
    const resetOnFeb28 = calculateNextMonthlyReset(31, onFeb28);
    expect(resetOnFeb28.toISOString()).toBe("2026-03-31T00:00:00.000Z");

    // On Feb 27, it resets on Feb 28 (effective day of February)
    const onFeb27 = new Date(Date.UTC(2026, 1, 27));
    const resetOnFeb27 = calculateNextMonthlyReset(31, onFeb27);
    expect(resetOnFeb27.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("handles leap year February 29 (e.g. 2028)", () => {
    const onFeb28Leap = new Date(Date.UTC(2028, 1, 28));
    const resetLeap = calculateNextMonthlyReset(31, onFeb28Leap);
    expect(resetLeap.toISOString()).toBe("2028-02-29T00:00:00.000Z");

    const onFeb29Leap = new Date(Date.UTC(2028, 1, 29));
    const resetAfterLeap = calculateNextMonthlyReset(31, onFeb29Leap);
    expect(resetAfterLeap.toISOString()).toBe("2028-03-31T00:00:00.000Z");
  });

  it("handles non-midnight time on reset day (e.g. Sept 17 10:00 UTC advances to Oct 17)", () => {
    const fromDateNonMidnight = new Date(Date.UTC(2026, 8, 17, 10, 30, 0));
    const reset = calculateNextMonthlyReset(17, fromDateNonMidnight);
    expect(reset.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });

  it("handles string resetDay cleanly (e.g. '17')", () => {
    const fromDate = new Date(Date.UTC(2026, 8, 3));
    const reset = calculateNextMonthlyReset("17", fromDate);
    expect(reset.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("defaults and clamps defensively on invalid or out-of-range resetDay", () => {
    const fromDate = new Date(Date.UTC(2026, 8, 3)); // Sept 3, 2026

    expect(calculateNextMonthlyReset(1, fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calculateNextMonthlyReset(null, fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calculateNextMonthlyReset(undefined, fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calculateNextMonthlyReset(0, fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calculateNextMonthlyReset(-5, fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(calculateNextMonthlyReset("invalid", fromDate).toISOString()).toBe("2026-10-01T00:00:00.000Z");

    // Value > 31 clamped to 31 (Sept has 30 days -> Sept 30)
    expect(calculateNextMonthlyReset(45, fromDate).toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("Ollama Cloud Quota — fraction-to-USD mapping", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns missing-key message when no API key provided", async () => {
    const result = await getOllamaUsage(null, {}, null);
    expect(result.message).toContain("API key not available");
  });

  it("returns auth error on 401", async () => {
    mockBoth(makeAuthErr(401), makeMeRes());
    const result = await getOllamaUsage(null, {}, "bad-key");
    expect(result.message).toMatch(/invalid or expired/i);
  });

  it("Pro plan: 0.315 fraction → $18.90 used of $60", async () => {
    // This is the exact case from the user's Ollama dashboard
    mockBoth(makeUsageRes(0.315), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Pro");
    const q = result.quotas["Monthly Credits"];
    expect(q).toBeDefined();
    expect(q.used).toBe(18.9);       // 0.315 * 60 = 18.90
    expect(q.total).toBe(60);
    expect(q.remainingPercentage).toBe(69); // Math.round((41.1/60)*100) = 69
    expect(q.unit).toBe("USD");
  });

  it("respects providerSpecificData.resetDay (e.g. 17th of month)", async () => {
    mockBoth(makeUsageRes(1.0), makeMeRes("pro"));
    const result = await getOllamaUsage(null, { resetDay: 17 }, "real-key");
    const q = result.quotas["Monthly Credits"];
    expect(q).toBeDefined();
    const resetDate = new Date(q.resetAt);
    expect(resetDate.getUTCDate()).toBe(17);
  });

  it("supports legacy providerSpecificData.billingResetDay fallback", async () => {
    mockBoth(makeUsageRes(1.0), makeMeRes("pro"));
    const result = await getOllamaUsage(null, { billingResetDay: 17 }, "real-key");
    const q = result.quotas["Monthly Credits"];
    expect(q).toBeDefined();
    const resetDate = new Date(q.resetAt);
    expect(resetDate.getUTCDate()).toBe(17);
  });

  it("prioritizes resetDay over legacy billingResetDay when both present", async () => {
    mockBoth(makeUsageRes(1.0), makeMeRes("pro"));
    const result = await getOllamaUsage(null, { resetDay: 17, billingResetDay: 25 }, "real-key");
    const q = result.quotas["Monthly Credits"];
    expect(q).toBeDefined();
    const resetDate = new Date(q.resetAt);
    expect(resetDate.getUTCDate()).toBe(17);
  });

  it("Pro plan: 0.0 fraction → $0.00 used (empty month)", async () => {
    mockBoth(makeUsageRes(0.0), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.quotas["Monthly Credits"].used).toBe(0);
    expect(result.quotas["Monthly Credits"].remainingPercentage).toBe(100);
  });

  it("Max plan: 0.5 fraction → $150 used of $300", async () => {
    mockBoth(makeUsageRes(0.5), makeMeRes("max"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Max");
    const q = result.quotas["Monthly Credits"];
    expect(q.used).toBe(150);
    expect(q.total).toBe(300);
    expect(q.remainingPercentage).toBe(50);
  });

  it("Team plan: 0.25 fraction → $250 used of $1000", async () => {
    mockBoth(makeUsageRes(0.25), makeMeRes("team"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Team");
    const q = result.quotas["Monthly Credits"];
    expect(q.used).toBe(250);
    expect(q.total).toBe(1000);
    expect(q.remainingPercentage).toBe(75);
  });

  it("plan detected from /api/me even when providerSpecificData has no plan", async () => {
    mockBoth(makeUsageRes(0.1), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key"); // no providerSpecificData.plan
    expect(result.plan).toContain("Pro");
    expect(result.quotas["Monthly Credits"].total).toBe(60);
  });

  it("parseQuotaData parses Ollama Monthly Credits for ProviderLimits UI", () => {
    const mockData = {
      plan: "Pro ($20/mo)",
      quotas: {
        "Monthly Credits": {
          name: "Monthly Credits",
          used: 18.9,
          total: 60,
          remainingPercentage: 69,
          unit: "USD",
          resetAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };
    const parsed = parseQuotaData("ollama", mockData);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Monthly Credits");
    expect(parsed[0].used).toBe(18.9);
    expect(parsed[0].total).toBe(60);
    expect(parsed[0].unit).toBe("USD");
  });
});
