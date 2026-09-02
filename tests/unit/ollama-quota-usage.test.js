import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// ─── mock proxyAwareFetch before importing misc.js ────────────────────────────
const mockFetch = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

const { getOllamaUsage } = await import("open-sse/services/usage/misc.js");

// Helper: build a minimal Ollama /api/usage response
function makeApiResponse(monthlyUsage = 0, activityCost = "0.00000") {
  return {
    activity: { cost: String(activityCost), period: { type: "last_4_weeks" }, models: [] },
    limits: { monthly: { usage: monthlyUsage, models: [] } },
  };
}

function makeMockRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("Ollama Cloud Quota (live API)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns missing-key message when no API key provided", async () => {
    const result = await getOllamaUsage(null, {}, null);
    expect(result.message).toContain("API key not available");
  });

  it("Free plan: shows Monthly Spend bar with live usage", async () => {
    mockFetch.mockResolvedValue(makeMockRes(makeApiResponse(0.315, "0.00000")));
    const result = await getOllamaUsage(null, { plan: "Free" }, "test-key");
    expect(result.plan).toContain("Free");
    expect(result.quotas["Monthly Spend"]).toBeDefined();
    expect(result.quotas["Monthly Spend"].used).toBe(0.315);
    expect(result.quotas["Monthly Spend"].total).toBe(0); // no ceiling
    expect(result.quotas["Monthly Spend"].unit).toBe("USD");
    expect(result.message).toBeUndefined();
  });

  it("Pro plan: shows Monthly Credits with real used/total bar", async () => {
    mockFetch.mockResolvedValue(makeMockRes(makeApiResponse(12.5)));
    const result = await getOllamaUsage(null, { plan: "Pro" }, "test-key");
    expect(result.plan).toContain("Pro");
    expect(result.quotas["Monthly Credits"]).toBeDefined();
    const q = result.quotas["Monthly Credits"];
    expect(q.total).toBe(60);
    expect(q.used).toBe(12.5);
    expect(q.remainingPercentage).toBe(79); // Math.round((47.5/60)*100)
    expect(q.unit).toBe("USD");
  });

  it("Max plan: $300 credit ceiling", async () => {
    mockFetch.mockResolvedValue(makeMockRes(makeApiResponse(100)));
    const result = await getOllamaUsage(null, { plan: "Max" }, "test-key");
    expect(result.quotas["Monthly Credits"].total).toBe(300);
    expect(result.quotas["Monthly Credits"].used).toBe(100);
  });

  it("Team plan: $1,000 credit ceiling", async () => {
    mockFetch.mockResolvedValue(makeMockRes(makeApiResponse(250)));
    const result = await getOllamaUsage(null, { plan: "Team" }, "test-key");
    expect(result.quotas["Monthly Credits"].total).toBe(1000);
    expect(result.quotas["Monthly Credits"].used).toBe(250);
  });

  it("returns auth error message on 401", async () => {
    mockFetch.mockResolvedValue(makeMockRes({ error: "unauthorized" }, 401));
    const result = await getOllamaUsage(null, {}, "bad-key");
    expect(result.message).toMatch(/invalid or expired/i);
  });

  it("parseQuotaData parses Ollama Monthly Spend correctly for ProviderLimits UI", () => {
    const mockData = {
      plan: "Free (Pay-As-You-Go)",
      quotas: {
        "Monthly Spend": {
          name: "Monthly Spend",
          used: 0.315,
          total: 0,
          remainingPercentage: 100,
          unit: "USD",
          resetAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };

    const parsed = parseQuotaData("ollama", mockData);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Monthly Spend");
    expect(parsed[0].used).toBe(0.315);
    expect(parsed[0].unit).toBe("USD");
    expect(parsed[0].resetAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
