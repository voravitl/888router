import { describe, it, expect, vi, afterEach } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// ─── mock proxyAwareFetch before importing the handler ───────────────────────
const mockFetch = vi.fn();
vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

const { getAlibabaTokenPlanUsage, expandEmbeddedJSON, findObjectWithKeys } =
  await import("open-sse/services/usage/alibabaTokenPlan.js");

const GATEWAY_HOST = "bailian-singapore-cs.alibabacloud.com";
const CONSOLE_HOST = "modelstudio.console.alibabacloud.com";

// Envelope shapes captured from the live Model Studio / Qwen personal
// gateways (see CodexBar fixtures personal_usage/subscription/quota_config and
// the TokenPlanMonthlyWindow regression tests): the payload is nested at
// data.DataV2.data.data and inner levels arrive as JSON-encoded strings.
const usageEnvelope = (usageObj) => ({
  code: "200",
  data: {
    DataV2: {
      data: JSON.stringify({
        success: true,
        data: JSON.stringify(usageObj),
      }),
      success: true,
      httpStatus: 200,
    },
    success: true,
    httpStatus: 200,
  },
  httpStatusCode: "200",
  requestId: "req-test",
  successResponse: true,
});

const userInfoOk = { secToken: "sec-tok-from-userinfo" };

const decodedUrl = (url) => decodeURIComponent(String(url));

const jsonRes = (body) => ({
  ok: true,
  status: 200,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

function mockConsole({ userInfo, subscription, quotaConfig, usage }) {
  mockFetch.mockImplementation(async (url) => {
    const u = decodedUrl(url);
    if (u.includes("/tool/user/info.json")) {
      return userInfo ? jsonRes(userInfo) : { ok: false, status: 500, text: async () => "" };
    }
    if (u.includes(`${GATEWAY_HOST}/data/api.json`) && u.includes("tokenplan/personal/api/v2/subscription")) {
      return subscription ? jsonRes(usageEnvelope(subscription)) : { ok: false, status: 500, text: async () => "" };
    }
    if (u.includes(`${GATEWAY_HOST}/data/api.json`) && u.includes("tokenplan/personal/api/v2/quota-config")) {
      return quotaConfig ? jsonRes(usageEnvelope(quotaConfig)) : { ok: false, status: 500, text: async () => "" };
    }
    if (u.includes(`${GATEWAY_HOST}/data/api.json`) && u.includes("tokenplan/personal/api/v2/usage")) {
      return usage ? jsonRes(usageEnvelope(usage)) : { ok: false, status: 500, text: async () => "" };
    }
    if (u.includes(CONSOLE_HOST)) {
      return { ok: true, status: 200, text: async () => "<html>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: \"dash-tok\" }</html>" };
    }
    throw new Error(`unmocked url: ${u}`);
  });
}

const psd = (consoleCookie = "csrf=abc; sec_token=cookie-sec-tok; cna=test-cna") =>
  ({ consoleCookie });

afterEach(() => vi.clearAllMocks());

describe("Alibaba Token Plan Personal quota — envelope expansion", () => {
  it("expandEmbeddedJSON unwraps stringified inner objects", () => {
    const input = { a: JSON.stringify({ b: JSON.stringify({ c: 1 }) }) };
    expect(expandEmbeddedJSON(input)).toEqual({ a: { b: { c: 1 } } });
  });

  it("findObjectWithKeys returns the node holding the requested keys", () => {
    const input = { x: [{ y: { per1MonthPercentage: 0.5, other: "deep" } }] };
    expect(findObjectWithKeys(input, ["per1MonthPercentage"])).toEqual({
      per1MonthPercentage: 0.5,
      other: "deep",
    });
  });
});

describe("getAlibabaTokenPlanUsage", () => {
  it("returns a cookie-required message without calling the console when no cookie is stored", async () => {
    const result = await getAlibabaTokenPlanUsage({}, null);
    expect(result.message).toMatch(/console cookie/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("whitespace-only cookie behaves as missing", async () => {
    const result = await getAlibabaTokenPlanUsage({ consoleCookie: "   " }, null);
    expect(result.message).toMatch(/console cookie/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("parses per1MonthPercentage (ratio of 1.0) into a monthly credits row", async () => {
    mockConsole({
      userInfo: userInfoOk,
      subscription: { specCode: "pro", status: "VALID", remainingDays: 12, endTime: 1791043200000 },
      quotaConfig: { pro: { monthly: 180000 } },
      usage: { per1MonthPercentage: 0.25, per1MonthResetTime: 1791043200000 },
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    expect(result.plan).toBe("Token Plan Pro");
    const row = result.quotas.Monthly;
    expect(row).toBeDefined();
    expect(row.total).toBe(180000);
    expect(row.used).toBe(45000);
    expect(row.remaining).toBe(135000);
    expect(row.remainingPercentage).toBe(75);
    expect(row.unit).toBe("credits");
    expect(row.resetAt).toBe(new Date(1791043200000).toISOString());
  });

  it("handles the live 8.69e-7 ratio without producing NaN", async () => {
    mockConsole({
      userInfo: userInfoOk,
      subscription: { specCode: "standard" },
      quotaConfig: { standard: { monthly: 45000 } },
      usage: { per1MonthPercentage: 8.690073333333334e-7, per1MonthResetTime: 1790611200000 },
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    const row = result.quotas.Monthly;
    expect(row.total).toBe(45000);
    expect(row.used).toBe(0);
    expect(row.remainingPercentage).toBe(100);
  });

  it("falls back to the documented monthly quota when quota-config is unreachable", async () => {
    mockConsole({
      userInfo: userInfoOk,
      subscription: { specCode: "essential" },
      quotaConfig: null,
      usage: { per1MonthPercentage: 0.4, per1MonthResetTime: 1791043200000 },
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    const row = result.quotas.Monthly;
    expect(row.total).toBe(25500); // Essential: 25,500 credits (official doc)
    expect(row.used).toBe(10200);
    expect(result.plan).toBe("Token Plan Essential");
  });

  it("resolves sec_token from user/info.json and sends it in the gateway body", async () => {
    mockConsole({
      userInfo: userInfoOk,
      subscription: { specCode: "lite" },
      quotaConfig: null,
      usage: { per1MonthPercentage: 0.1, per1MonthResetTime: 1791043200000 },
    });
    await getAlibabaTokenPlanUsage(psd(), null);
    const usageCall = mockFetch.mock.calls.find(([url]) =>
      decodedUrl(url).includes("tokenplan/personal/api/v2/usage"),
    );
    expect(usageCall).toBeDefined();
    const body = String(usageCall[1]?.body ?? "");
    expect(decodeURIComponent(body)).toContain("sec_token=sec-tok-from-userinfo");
    // The params envelope carries the console contract the live gateway requires.
    const params = new URLSearchParams(body).get("params");
    const parsed = JSON.parse(params);
    expect(parsed.Api).toBe("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage");
    expect(parsed.Data.cornerstoneParam.consoleSite).toBe("MODELSTUDIO_ALBABACLOUD");
    expect(parsed.Data.cornerstoneParam.switchAgent).toBeUndefined();
    expect(parsed.Data.cornerstoneParam["X-Anonymous-Id"]).toBe("test-cna");
  });

  it("falls back to the cookie sec_token when user/info.json fails", async () => {
    mockConsole({
      userInfo: null,
      subscription: null,
      quotaConfig: null,
      usage: { per1MonthPercentage: 0.1, per1MonthResetTime: 1791043200000 },
    });
    await getAlibabaTokenPlanUsage(psd("sec_token=from-cookie; cna=x"), null);
    const usageCall = mockFetch.mock.calls.find(([url]) =>
      decodedUrl(url).includes("tokenplan/personal/api/v2/usage"),
    );
    expect(decodeURIComponent(String(usageCall[1]?.body ?? ""))).toContain("sec_token=from-cookie");
  });

  it("still calls the gateway when no sec_token can be resolved (cookie-only path)", async () => {
    // user/info.json 500, no sec_token in cookie, dashboard HTML carries none.
    mockFetch.mockImplementation(async (url) => {
      const u = decodedUrl(url);
      if (u.includes("/tool/user/info.json")) return { ok: false, status: 500, text: async () => "" };
      if (u.includes(`${CONSOLE_HOST}`)) return { ok: true, status: 200, text: async () => "<html>no token here</html>" };
      if (u.includes(GATEWAY_HOST)) {
        return jsonRes(usageEnvelope({ per1MonthPercentage: 0.1, per1MonthResetTime: 1791043200000 }));
      }
      throw new Error(`unmocked url: ${u}`);
    });
    const result = await getAlibabaTokenPlanUsage(psd("cna=x"), null);
    expect(result.quotas.Monthly).toBeDefined();
    expect(result.quotas.Monthly.total).toBe(0); // tier unknown
    expect(result.quotas.Monthly.remainingPercentage).toBe(90);
  });

  it("surfaces the login page when the console answers NotLogined (expired cookie)", async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = decodedUrl(url);
      if (u.includes("/tool/user/info.json")) return { ok: false, status: 500, text: async () => "" };
      if (u.includes(`${CONSOLE_HOST}`)) return { ok: true, status: 200, text: async () => "<html></html>" };
      if (u.includes(GATEWAY_HOST)) {
        return jsonRes({
          code: "200",
          data: {
            success: false,
            httpStatus: 200,
            errorCode: "BailianGateway.Login.NotLogined",
            errorMsg: "BailianGateway.Login.NotLogined",
          },
          httpStatusCode: "200",
          successResponse: true,
        });
      }
      throw new Error(`unmocked url: ${u}`);
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    expect(result.message).toMatch(/cookie/i);
    // Login errors are not retried.
    const usageCalls = mockFetch.mock.calls.filter(([url]) =>
      decodedUrl(url).includes("tokenplan/personal/api/v2/usage"),
    );
    expect(usageCalls).toHaveLength(1);
  });

  it("treats a 200 HTML login page as an expired cookie, not a parse error", async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = decodedUrl(url);
      if (u.includes("/tool/user/info.json")) return { ok: false, status: 500, text: async () => "" };
      if (u.includes(`${CONSOLE_HOST}`)) return { ok: true, status: 200, text: async () => "<html></html>" };
      if (u.includes(GATEWAY_HOST)) {
        return {
          ok: true,
          status: 200,
          text: async () => "<!doctype html><html><head><title>Sign in</title></head><body>login</body></html>",
        };
      }
      throw new Error(`unmocked url: ${u}`);
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    expect(result.message).toMatch(/cookie/i);
  });

  it("retries the usage call once when the gateway answers 200 with an empty payload", async () => {
    let usageCalls = 0;
    mockFetch.mockImplementation(async (url) => {
      const u = decodedUrl(url);
      if (u.includes("/tool/user/info.json")) return jsonRes(userInfoOk);
      if (u.includes(GATEWAY_HOST) && u.includes("quota-config")) {
        return jsonRes(usageEnvelope({ pro: { monthly: 180000 } }));
      }
      if (u.includes(GATEWAY_HOST) && u.includes("subscription")) {
        return jsonRes(usageEnvelope({ specCode: "pro" }));
      }
      if (u.includes(GATEWAY_HOST) && u.includes("tokenplan/personal/api/v2/usage")) {
        usageCalls += 1;
        return jsonRes({ code: "200", data: { DataV2: { data: { success: true, data: {} } } }, httpStatusCode: "200" });
      }
      throw new Error(`unmocked url: ${u}`);
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    expect(result.message).toMatch(/unavailable|unexpected/i);
    expect(usageCalls).toBe(2);
  });

  it("parses legacy per5Hour/per1Week fields into extra rows when present", async () => {
    mockConsole({
      userInfo: userInfoOk,
      subscription: { specCode: "pro" },
      quotaConfig: { pro: { monthly: 180000, five_hour: 12000, weekly: 40000 } },
      usage: {
        per5HourPercentage: 0.01,
        per1WeekPercentage: 0.02,
        per1MonthPercentage: 0.3,
        per5HourResetTime: 1791043200000,
        per1WeekResetTime: 1791129600000,
        per1MonthResetTime: 1791043200000,
      },
    });
    const result = await getAlibabaTokenPlanUsage(psd(), null);
    expect(Object.keys(result.quotas)).toEqual(
      expect.arrayContaining(["5 Hours (rolling)", "Weekly", "Monthly"]),
    );
    expect(result.quotas["5 Hours (rolling)"].total).toBe(12000);
    expect(result.quotas.Weekly.total).toBe(40000);
    expect(result.quotas.Monthly.remainingPercentage).toBe(70);
  });
});

describe("parseQuotaData('alitp-intl')", () => {
  it("forwards remainingPercentage, unit and credits rows to the table", () => {
    const parsed = parseQuotaData("alitp-intl", {
      plan: "Token Plan Pro",
      quotas: {
        Monthly: {
          name: "Monthly",
          used: 45000,
          total: 180000,
          remaining: 135000,
          remainingPercentage: 75,
          unit: "credits",
          resetAt: "2026-11-17T00:00:00.000Z",
        },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "Monthly",
      used: 45000,
      total: 180000,
      remainingPercentage: 75,
      unit: "credits",
    });
  });
});
