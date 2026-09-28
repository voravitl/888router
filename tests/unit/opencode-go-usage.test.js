import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Live response shape captured via GET /zen/go/v1/usage (Bearer key) —
// `percent` is USED percent per window (rolling=5h, weekly, monthly).
const LIVE_USAGE = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-09-28T15:55:55.994Z" },
    weekly: { status: "ok", percent: 24, resetsAt: "2026-10-05T00:00:00.000Z" },
    monthly: { status: "ok", percent: 12, resetsAt: "2026-10-28T05:49:18.000Z" },
  },
};

describe("opencode-go registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("opencode-go");
    expect(USAGE_APIKEY_PROVIDERS).toContain("opencode-go");
  });
});

describe("getUsageForProvider(opencode-go)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs /zen/go/v1/usage with Bearer apiKey", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(LIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("OpenCode Go");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(USAGE_URL);
    expect(opts.method).toBe("GET");
    expect(opts.headers.Authorization).toBe("Bearer ocg-test-key");
  });

  it("maps windows to percent-based quotas (percent = used, remaining = 100 - used)", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(LIVE_USAGE));

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });

    expect(usage.quotas["Rolling (5h)"]).toEqual({
      used: 0,
      total: 100,
      remaining: 100,
      resetAt: "2026-09-28T15:55:55.994Z",
      unlimited: false,
    });
    expect(usage.quotas["Weekly"]).toEqual({
      used: 24,
      total: 100,
      remaining: 76,
      resetAt: "2026-10-05T00:00:00.000Z",
      unlimited: false,
    });
    expect(usage.quotas["Monthly"]).toEqual({
      used: 12,
      total: 100,
      remaining: 88,
      resetAt: "2026-10-28T05:49:18.000Z",
      unlimited: false,
    });
  });

  it("clamps out-of-range percent values", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 130, resetsAt: "2026-09-28T15:55:55.994Z" },
          weekly: { status: "ok", percent: -5, resetsAt: "2026-10-05T00:00:00.000Z" },
        },
      }),
    );

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });

    expect(usage.quotas["Rolling (5h)"].used).toBe(100);
    expect(usage.quotas["Rolling (5h)"].remaining).toBe(0);
    expect(usage.quotas["Weekly"].used).toBe(0);
    expect(usage.quotas["Weekly"].remaining).toBe(100);
  });

  it("labels unknown window keys by their raw name and skips non-object windows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 5, resetsAt: "2026-09-28T15:55:55.994Z" },
          daily: { status: "ok", percent: 1, resetsAt: "2026-09-29T00:00:00.000Z" },
          legacy: "garbage",
        },
      }),
    );

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });

    expect(usage.quotas["daily"]).toMatchObject({ used: 1, total: 100 });
    expect(usage.quotas.legacy).toBeUndefined();
  });

  it("skips windows without a finite percent instead of faking 0% used", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({
        usage: {
          rolling: { status: "ok", percent: 7, resetsAt: "2026-09-28T15:55:55.994Z" },
          weekly: { status: "ok", resetsAt: "2026-10-05T00:00:00.000Z" },
          monthly: { status: "ok", percent: "soon", resetsAt: "2026-10-28T05:49:18.000Z" },
        },
      }),
    );

    const usage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });

    expect(Object.keys(usage.quotas)).toEqual(["Rolling (5h)"]);
    expect(usage.quotas["Rolling (5h)"].used).toBe(7);
  });

  it("returns message on missing key / 401 / malformed body", async () => {
    const missing = await getUsageForProvider({ provider: "opencode-go" });
    expect(missing.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "no" }, 401));
    const auth = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "bad",
    });
    expect(auth.message).toMatch(/auth|key|401/i);

    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    const noUsage = await getUsageForProvider({
      provider: "opencode-go",
      apiKey: "ocg-test-key",
    });
    expect(noUsage.message).toMatch(/no usage data/i);
  });
});

describe("parseQuotaData(opencode-go)", () => {
  it("forwards percent-based rows with remaining as 0-100", () => {
    const rows = parseQuotaData("opencode-go", {
      plan: "OpenCode Go",
      quotas: {
        "Rolling (5h)": { used: 0, total: 100, remaining: 100, resetAt: "2026-09-28T15:55:55.994Z" },
        Weekly: { used: 24, total: 100, remaining: 76, resetAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Rolling (5h)",
      used: 0,
      total: 100,
      remaining: 100,
    });
    expect(rows[1]).toMatchObject({
      name: "Weekly",
      used: 24,
      total: 100,
      remaining: 76,
    });
  });
});
