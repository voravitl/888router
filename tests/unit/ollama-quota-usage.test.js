import { describe, it, expect, vi, afterEach } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// ─── mock proxyAwareFetch before importing misc.js ────────────────────────────
const mockFetch = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

const { getOllamaUsage } = await import("open-sse/services/usage/misc.js");

// REAL /api/usage response shape, verified live against ollama.com on
// 2026-10-25 (GET ?range=30d with a Bearer key):
//   { range, from, until,
//     totals: { request_count, usage_usd, input_tokens,
//               cached_input_tokens, output_tokens },
//     buckets: [...] }
// The pre-2026-10 shape ({ activity, limits: { monthly: { usage } } }) no
// longer exists upstream — parsing it silently yields 0, which rendered as a
// fake "100% remaining" while the account had real spend (90.57 USD/30d
// observed on the live key).
function makeUsageRes(usageUsd = 38.96) {
  return {
    ok: true, status: 200,
    json: async () => ({
      range: "30d",
      from: "2026-09-25T00:00:00Z",
      until: "2026-10-25T13:05:06Z",
      totals: {
        request_count: 14675,
        usage_usd: usageUsd,
        input_tokens: 2311817523,
        cached_input_tokens: 2249912100,
        output_tokens: 26318416,
      },
      buckets: [],
    }),
    text: async () => "",
  };
}

// Ollama /api/me POST response — Plan field drives the credit ceiling
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

describe("Ollama Cloud Quota — real /api/usage shape (totals.usage_usd)", () => {
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

  it("requests the 30-day window, not the 7d default", async () => {
    mockBoth(makeUsageRes(38.96), makeMeRes("pro"));
    await getOllamaUsage(null, {}, "real-key");
    const usageUrl = mockFetch.mock.calls.map(c => c[0]).find(u => String(u).includes("/api/usage"));
    expect(String(usageUrl)).toContain("range=30d");
  });

  it("Pro plan: $38.96 spent → used 38.96 of $60", async () => {
    mockBoth(makeUsageRes(38.96), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Pro");
    const q = result.quotas["Monthly Credits"];
    expect(q).toBeDefined();
    expect(q.used).toBe(38.96);
    expect(q.total).toBe(60);
    expect(q.remainingPercentage).toBe(35); // round((60-38.96)/60*100)
    expect(q.unit).toBe("USD");
  });

  it("Pro plan: spend exceeding the credit ceiling clamps remaining to 0", async () => {
    // Live case: 90.57 USD spent in 30 days on a $60 Pro allocation
    mockBoth(makeUsageRes(90.57), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    const q = result.quotas["Monthly Credits"];
    expect(q.used).toBe(90.57);
    expect(q.remaining).toBe(0);
    expect(q.remainingPercentage).toBe(0);
  });

  it("Max plan: $150 spent → 150 of $300", async () => {
    mockBoth(makeUsageRes(150), makeMeRes("max"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Max");
    const q = result.quotas["Monthly Credits"];
    expect(q.used).toBe(150);
    expect(q.total).toBe(300);
    expect(q.remainingPercentage).toBe(50);
  });

  it("Team plan: $250 spent → 250 of $1000", async () => {
    mockBoth(makeUsageRes(250), makeMeRes("team"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.plan).toContain("Team");
    const q = result.quotas["Monthly Credits"];
    expect(q.used).toBe(250);
    expect(q.total).toBe(1000);
    expect(q.remainingPercentage).toBe(75);
  });

  it("plan detected from /api/me even when providerSpecificData has no plan", async () => {
    mockBoth(makeUsageRes(10), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key"); // no providerSpecificData.plan
    expect(result.plan).toContain("Pro");
    expect(result.quotas["Monthly Credits"].total).toBe(60);
  });

  it("free tier surfaces real spend without inventing a percentage ceiling", async () => {
    mockBoth(makeUsageRes(12.34), makeMeRes("free"));
    const result = await getOllamaUsage(null, {}, "real-key");
    const q = result.quotas["Used (USD)"];
    expect(q).toBeDefined();
    expect(q.used).toBe(12.34);
    expect(q.unlimited).toBe(true);
  });

  it("usage payload without totals is skipped, NEVER rendered as $0 used / 100% left", async () => {
    // Regression guard for the 2026-10-25 incident: when the response shape
    // drifts (limits.monthly.usage vanished), a 0 default rendered a fake
    // full balance. Missing data must skip, not lie.
    mockBoth({
      ok: true, status: 200,
      json: async () => ({ range: "30d", totals: {} , buckets: [] }),
      text: async () => "",
    }, makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.quotas).toEqual({});
    expect(result.message).toMatch(/unavailable/i);
  });

  it("without a billing day, the rolling 30-day total is not given an invented reset date", async () => {
    mockBoth(makeUsageRes(38.96), makeMeRes("pro"));
    const result = await getOllamaUsage(null, {}, "real-key");
    expect(result.quotas["Monthly Credits"].resetAt).toBeNull();
  });

  describe("billing cycle from providerSpecificData.resetDay", () => {
    afterEach(() => vi.useRealTimers());

    // Daily UTC buckets, as /api/usage?range=30d returns them.
    function dailyBuckets(startIso, days, usdForDay) {
      const start = Date.parse(startIso);
      return Array.from({ length: days }, (_, i) => {
        const from = new Date(start + i * 86_400_000);
        return {
          from: from.toISOString().replace(".000Z", "Z"),
          until: new Date(from.getTime() + 86_400_000).toISOString().replace(".000Z", "Z"),
          usage_usd: usdForDay(from),
        };
      });
    }

    function usageWithBuckets(buckets) {
      const total = buckets.reduce((sum, b) => sum + b.usage_usd, 0);
      return {
        ok: true, status: 200,
        json: async () => ({ range: "30d", totals: { usage_usd: total }, buckets }),
        text: async () => "",
      };
    }

    it("counts only spend since the current cycle start and resets on the next billing day", async () => {
      // Live shape on 2026-10-29: $51.98 over 30 days, $49.31 since Oct 17.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-29T01:31:26Z"));
      const buckets = dailyBuckets("2026-09-29T00:00:00Z", 31, (d) =>
        d < new Date("2026-10-17T00:00:00Z") ? 0.25 : d.getUTCDate() === 29 ? 0 : 4.10917,
      );
      mockBoth(usageWithBuckets(buckets), makeMeRes("pro"));

      const result = await getOllamaUsage(null, { resetDay: 17 }, "real-key");
      const q = result.quotas["Monthly Credits"];
      expect(q.used).toBe(49.31);
      expect(q.remaining).toBe(10.69);
      expect(q.remainingPercentage).toBe(18);
      expect(q.resetAt).toBe("2026-11-17T00:00:00.000Z");
    });

    it("before this month's billing day, the cycle started on last month's billing day", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
      const buckets = dailyBuckets("2026-09-10T00:00:00Z", 31, (d) =>
        d < new Date("2026-09-17T00:00:00Z") ? 5 : 1,
      );
      mockBoth(usageWithBuckets(buckets), makeMeRes("pro"));

      const result = await getOllamaUsage(null, { resetDay: "17" }, "real-key");
      const q = result.quotas["Monthly Credits"];
      expect(q.used).toBe(24); // Sep 17 .. Oct 10 = 24 days at $1
      expect(q.resetAt).toBe("2026-10-17T00:00:00.000Z");
    });

    it("on the billing day itself, a new cycle has started", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-17T06:00:00Z"));
      const buckets = dailyBuckets("2026-09-17T00:00:00Z", 31, (d) => (d.getUTCDate() === 17 && d.getUTCMonth() === 9 ? 2 : 3));
      mockBoth(usageWithBuckets(buckets), makeMeRes("pro"));

      const q = (await getOllamaUsage(null, { resetDay: 17 }, "real-key")).quotas["Monthly Credits"];
      expect(q.used).toBe(2);
      expect(q.resetAt).toBe("2026-11-17T00:00:00.000Z");
    });

    it("a billing day past the end of a short month clamps to that month's last day", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2027-02-20T00:00:00Z"));
      const buckets = dailyBuckets("2027-01-21T00:00:00Z", 31, (d) => (d < new Date("2027-01-31T00:00:00Z") ? 9 : 1));
      mockBoth(usageWithBuckets(buckets), makeMeRes("pro"));

      const q = (await getOllamaUsage(null, { resetDay: 31 }, "real-key")).quotas["Monthly Credits"];
      expect(q.used).toBe(21); // Jan 31 .. Feb 20
      expect(q.resetAt).toBe("2027-02-28T00:00:00.000Z");
    });

    it("buckets that do not reach back to the cycle start are not reported as cycle usage", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-29T01:00:00Z"));
      const buckets = dailyBuckets("2026-10-20T00:00:00Z", 10, () => 1);
      mockBoth(usageWithBuckets(buckets), makeMeRes("pro"));

      const result = await getOllamaUsage(null, { resetDay: 17 }, "real-key");
      expect(result.quotas).toEqual({});
      expect(result.message).toMatch(/unavailable/i);
    });

    it.each([0, 32, "abc", 17.5])("an invalid billing day (%s) falls back to the rolling 30-day total", async (resetDay) => {
      mockBoth(makeUsageRes(38.96), makeMeRes("pro"));
      const q = (await getOllamaUsage(null, { resetDay }, "real-key")).quotas["Monthly Credits"];
      expect(q.used).toBe(38.96);
      expect(q.resetAt).toBeNull();
    });
  });

  it("parseQuotaData parses Ollama Monthly Credits for ProviderLimits UI", () => {
    const mockData = {
      plan: "Pro ($20/mo)",
      quotas: {
        "Monthly Credits": {
          name: "Monthly Credits",
          used: 38.96,
          total: 60,
          remaining: 21.04,
          remainingPercentage: 35,
          unit: "USD",
          resetAt: "2026-11-01T00:00:00.000Z",
        },
      },
    };
    const parsed = parseQuotaData("ollama", mockData);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Monthly Credits");
    expect(parsed[0].used).toBe(38.96);
    expect(parsed[0].total).toBe(60);
    expect(parsed[0].unit).toBe("USD");
  });
});
