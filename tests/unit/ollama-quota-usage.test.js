import { describe, it, expect } from "vitest";
import { getOllamaUsage } from "open-sse/services/usage/misc.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("Ollama Cloud Quota & Monthly Credits Tracking", () => {
  it("returns Pay-As-You-Go plan for default free accounts", async () => {
    const result = await getOllamaUsage("test-key", {});
    expect(result.plan).toContain("Free");
    expect(result.message).toContain("Pay-as-you-go");
    expect(Object.keys(result.quotas)).toHaveLength(0);
  });

  it("returns $60 monthly credit quota for Pro plan", async () => {
    const result = await getOllamaUsage("test-key", { plan: "Pro" });
    expect(result.plan).toContain("Pro");
    expect(result.quotas.monthly_credits).toBeDefined();
    expect(result.quotas.monthly_credits.total).toBe(60);
    expect(result.quotas.monthly_credits.remaining).toBe(60);
    expect(result.quotas.monthly_credits.unit).toBe("USD");
    expect(result.quotas.monthly_credits.resetAt).toBeDefined();
  });

  it("returns $300 monthly credit quota for Max plan", async () => {
    const result = await getOllamaUsage("test-key", { plan: "Max" });
    expect(result.plan).toContain("Max");
    expect(result.quotas.monthly_credits.total).toBe(300);
    expect(result.quotas.monthly_credits.remaining).toBe(300);
  });

  it("returns $1,000 monthly credit quota for Team plan", async () => {
    const result = await getOllamaUsage("test-key", { plan: "Team" });
    expect(result.plan).toContain("Team");
    expect(result.quotas.monthly_credits.total).toBe(1000);
    expect(result.quotas.monthly_credits.remaining).toBe(1000);
  });

  it("parseQuotaData parses Ollama monthly credits correctly for ProviderLimits UI", () => {
    const mockData = {
      plan: "Pro ($20/mo)",
      quotas: {
        monthly_credits: {
          name: "Monthly Credits",
          used: 12.5,
          total: 60,
          remainingPercentage: 79,
          unit: "USD",
          resetAt: "2026-10-01T00:00:00.000Z",
        },
      },
    };

    const parsed = parseQuotaData("ollama", mockData);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Monthly Credits");
    expect(parsed[0].used).toBe(12.5);
    expect(parsed[0].total).toBe(60);
    expect(parsed[0].unit).toBe("USD");
    expect(parsed[0].resetAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
