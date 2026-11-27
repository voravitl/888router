import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

function makeUsageFetchMock(models, weeklyGroups = []) {
  return async (url) => {
    if (url.includes(":loadCodeAssist")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cloudaicompanionProject: "project-1",
          currentTier: { name: "Pro" },
          paidTier: { id: "pro-tier" },
        }),
        text: async () => "{}",
      };
    }
    if (url.includes(":fetchAvailableModels")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models }),
        text: async () => "{}",
      };
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ groups: weeklyGroups }),
        text: async () => "{}",
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  };
}

describe("Gemini 4 Neon Antigravity registry & helpers", () => {
  it("registers all 5 Gemini 4 Neon live wire entries in antigravity registry", async () => {
    const { default: antigravityConfig } = await import("../../open-sse/providers/registry/antigravity.js");
    const neonModels = antigravityConfig.models.filter((m) => m.id.startsWith("gemini-4-neon"));

    expect(neonModels).toEqual([
      { id: "gemini-4-neon", name: "Gemini 4 Neon", upstreamModelId: "gemini-4-neon-high(high)" },
      { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", upstreamModelId: "gemini-4-neon-xhigh(xhigh)" },
      { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", upstreamModelId: "gemini-4-neon-high(high)" },
      { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)", upstreamModelId: "gemini-4-neon-medium(medium)" },
      { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)", upstreamModelId: "gemini-4-neon-low(low)" },
    ]);
    expect(antigravityConfig.models[0].id).toBe("gemini-4-hydrogen");
  });

  it.each([
    ["gemini-4-neon", "gemini-4-neon-high(high)"],
    ["gemini-4-neon-tiered", "gemini-4-neon-high(high)"],
    ["gemini-4-neon-xhigh", "gemini-4-neon-xhigh(xhigh)"],
    ["gemini-4-neon-high", "gemini-4-neon-high(high)"],
    ["gemini-4-neon-medium", "gemini-4-neon-medium(medium)"],
    ["gemini-4-neon-low", "gemini-4-neon-low(low)"],
    ["gemini-4-neon-tiered-xhigh", "gemini-4-neon-xhigh(xhigh)"],
    ["gemini-4-neon-tiered-high", "gemini-4-neon-high(high)"],
    ["gemini-4-neon-tiered-medium", "gemini-4-neon-medium(medium)"],
    ["gemini-4-neon-tiered-low", "gemini-4-neon-low(low)"],
    [" Gemini-4-Neon-Tiered-XHigh ", "gemini-4-neon-xhigh(xhigh)"],
  ])("resolveAntigravityNeonModel(%s) -> %s", async (input, expected) => {
    const { resolveAntigravityNeonModel } = await import("../../open-sse/providers/models/helpers.js");
    expect(resolveAntigravityNeonModel(input)).toBe(expected);
  });

  it.each([null, undefined, "", "gemini-4-hydrogen", "gemini-4-argon-high", "gemini-4-neon-sonar"])(
    "resolveAntigravityNeonModel leaves non-Neon / boundary input untouched: %s",
    async (input) => {
      const { resolveAntigravityNeonModel, resolveAntigravityHydrogenModel } = await import(
        "../../open-sse/providers/models/helpers.js"
      );
      expect(resolveAntigravityNeonModel(input)).toBe(input);
      expect(resolveAntigravityHydrogenModel("gemini-4-hydrogen-tiered-xhigh")).toBe("gemini-4-hydrogen-xhigh(xhigh)");
    },
  );

  it("expands gemini-4-neon-tiered into 5 entries and hides junk/unexpanded Neon IDs", async () => {
    const { parseAntigravityLiveModels, isAntigravityHiddenModel } = await import(
      "../../open-sse/providers/models/helpers.js"
    );
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");

    for (const payload of [
      {
        models: {
          "gemini-4-neon-tiered": { displayName: "Gemini 4 Neon" },
          "gemini-4-neon-tiered-xhigh": { displayName: "Bad Tiered XHigh" },
          "gemini-4-neon-sonar": { displayName: "Sonar" },
          "gemini-4-neon-disabled": { displayName: "Disabled" },
        },
      },
      {
        models: [
          { id: "gemini-4-neon-tiered", displayName: "Gemini 4 Neon" },
          { id: "gemini-4-neon-tiered-xhigh" },
          { id: "gemini-4-neon-sonar" },
          { id: "gemini-4-neon-disabled" },
        ],
      },
    ]) {
      const parsed = parseAntigravityLiveModels(payload, PROVIDERS.antigravity?.models);
      const ids = parsed.map((m) => m.id);
      expect(ids).toContain("gemini-4-neon");
      expect(ids).toContain("gemini-4-neon-xhigh");
      expect(ids).toContain("gemini-4-neon-high");
      expect(ids).toContain("gemini-4-neon-medium");
      expect(ids).toContain("gemini-4-neon-low");
      expect(ids).not.toContain("gemini-4-neon-tiered");
      expect(ids).not.toContain("gemini-4-neon-tiered-xhigh");
      expect(ids).not.toContain("gemini-4-neon-sonar");
      expect(ids).not.toContain("gemini-4-neon-disabled");
    }

    expect(isAntigravityHiddenModel("gemini-4-neon")).toBe(false);
    expect(isAntigravityHiddenModel("gemini-4-neon-xhigh")).toBe(false);
    expect(isAntigravityHiddenModel("gemini-4-neon-tiered")).toBe(true);
    expect(isAntigravityHiddenModel("gemini-4-neon-tiered-xhigh")).toBe(true);
    expect(isAntigravityHiddenModel("gemini-4-neon-sonar")).toBe(true);
  });
});

describe("Gemini 4 Neon catalog resolution & executor transform", () => {
  it.each([
    ["gemini-4-neon", "gemini-4-neon-high(high)", "gemini-4-neon-high", "high"],
    ["gemini-4-neon-tiered", "gemini-4-neon-high(high)", "gemini-4-neon-high", "high"],
    ["gemini-4-neon-tiered-xhigh", "gemini-4-neon-xhigh(xhigh)", "gemini-4-neon-xhigh", null],
    ["gemini-4-neon-tiered-high", "gemini-4-neon-high(high)", "gemini-4-neon-high", "high"],
    ["gemini-4-neon-tiered-medium", "gemini-4-neon-medium(medium)", "gemini-4-neon-medium", "medium"],
    ["gemini-4-neon-tiered-low", "gemini-4-neon-low(low)", "gemini-4-neon-low", "low"],
    ["gemini-4-neon-xhigh", "gemini-4-neon-xhigh(xhigh)", "gemini-4-neon-xhigh", null],
    ["gemini-4-neon-high", "gemini-4-neon-high(high)", "gemini-4-neon-high", "high"],
    ["gemini-4-neon-medium", "gemini-4-neon-medium(medium)", "gemini-4-neon-medium", "medium"],
    ["gemini-4-neon-low", "gemini-4-neon-low(low)", "gemini-4-neon-low", "low"],
    ["gemini-4-neon-tiered-xhigh(low)", "gemini-4-neon-xhigh(low)", "gemini-4-neon-xhigh", "low"],
    ["gemini-4-neon(medium)", "gemini-4-neon-high(medium)", "gemini-4-neon-high", "medium"],
  ])("resolves ag/%s -> %s (wire %s)", async (inputId, expectedUpstream, expectedWireModel, expectedLevel) => {
    const { getModelUpstreamId, isValidModel, findModelName } = await import("../../open-sse/config/providerModels.js");
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { applyThinking, stripThinkingSuffix } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    expect(isValidModel("ag", inputId)).toBe(true);
    expect(findModelName("ag", "gemini-4-neon")).toBe("Gemini 4 Neon");
    expect(getModelUpstreamId("ag", inputId)).toBe(expectedUpstream);
    expect(getModelUpstreamId("antigravity", inputId)).toBe(expectedUpstream);

    const upstream = getModelUpstreamId("ag", inputId);
    const body = {
      model: stripThinkingSuffix(upstream),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };
    if (expectedLevel) {
      applyThinking("antigravity", upstream, body, "antigravity");
    }

    const finalBody = new AntigravityExecutor().transformRequest(upstream, body, true, { projectId: "project" });
    expect(finalBody.model).toBe(expectedWireModel);
    if (expectedLevel) {
      expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: expectedLevel,
        includeThoughts: true,
      });
    }
  });

  it.each(["antigravity", "gemini", "vertex"])("exposes gemini-level non-disableable reasoning on %s", async (provider) => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const caps = getCapabilitiesForModel(provider, "gemini-4-neon");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
  });
});

describe("Antigravity quota: Gemini 4 Neon", () => {
  beforeEach(async () => {
    proxyAwareFetch.mockReset();
    const { _clearWeeklyCache } = await import("../../open-sse/services/usage/antigravity-weekly.js");
    _clearWeeklyCache();
  });

  it("tracks gemini-4-neon-high, aliases bare gemini-4-neon, and pools both Neon and Argon under Gemini (all models)", async () => {
    proxyAwareFetch.mockImplementation(
      makeUsageFetchMock({
        "gemini-4-neon-high": {
          displayName: "Gemini 4 Neon (High)",
          quotaInfo: { remainingFraction: 0.65, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-argon-high": {
          displayName: "Gemini 4 Argon (High)",
          quotaInfo: { remainingFraction: 0.25, resetTime: "2026-11-19T12:00:00Z" },
        },
      }),
    );

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-4-neon-high"]).toMatchObject({
      used: 350,
      total: 1000,
      remainingPercentage: 65,
      displayName: "Gemini 4 Neon (High)",
    });
    expect(usage.quotas["gemini-4-neon"]).toMatchObject({
      used: 350,
      total: 1000,
      remainingPercentage: 65,
      displayName: "Gemini 4 Neon",
    });
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 25,
      memberCount: 2,
      family: "gemini",
      familyKey: "gemini",
    });
    expect(usage.quotas["Gemini 4 Argon (all models)"]).toBeUndefined();
  });

  it("preserves explicit bare gemini-4-neon entry and tracks all Neon tier variants in importantModels", async () => {
    proxyAwareFetch.mockImplementation(
      makeUsageFetchMock({
        "gemini-4-neon": {
          displayName: "Gemini 4 Neon",
          quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-neon-xhigh": {
          displayName: "Gemini 4 Neon (XHigh)",
          quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-neon-high": {
          displayName: "Gemini 4 Neon (High)",
          quotaInfo: { remainingFraction: 0.7, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-neon-medium": {
          displayName: "Gemini 4 Neon (Medium)",
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-neon-low": {
          displayName: "Gemini 4 Neon (Low)",
          quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-19T12:00:00Z" },
        },
        "gemini-4-neon-tiered": {
          displayName: "Gemini 4 Neon Tiered",
          quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-19T12:00:00Z" },
        },
      }),
    );

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-4-neon"].remainingPercentage).toBe(40);
    expect(usage.quotas["gemini-4-neon-xhigh"].remainingPercentage).toBe(50);
    expect(usage.quotas["gemini-4-neon-high"].remainingPercentage).toBe(70);
    expect(usage.quotas["gemini-4-neon-medium"].remainingPercentage).toBe(80);
    expect(usage.quotas["gemini-4-neon-low"].remainingPercentage).toBe(90);
    expect(usage.quotas["gemini-4-neon-tiered"].remainingPercentage).toBe(60);
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 40,
      memberCount: 6,
    });
  });

  it("reconciles both Gemini 4 Neon and Gemini 4 Argon with gemini_weekly and ignores legacy Argon weekly group", async () => {
    proxyAwareFetch.mockImplementation(
      makeUsageFetchMock(
        {
          "gemini-4-neon-high": {
            displayName: "Gemini 4 Neon (High)",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-11-19T12:00:00Z" },
          },
          "gemini-4-argon-high": {
            displayName: "Gemini 4 Argon (High)",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-11-19T12:00:00Z" },
          },
        },
        [
          {
            displayName: "Gemini Models",
            buckets: [{
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              remainingFraction: 0,
              resetTime: "2026-11-25T00:00:00Z",
            }],
          },
          {
            displayName: "Gemini 4 Argon",
            buckets: [{
              bucketId: "gemini-argon-wtu-weekly",
              displayName: "Gemini 4 Argon Weekly Limit",
              remainingFraction: 0.8,
              resetTime: "2026-11-25T00:00:00Z",
            }],
          },
        ],
      ),
    );

    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-4-neon-high"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-4-neon"].remainingPercentage).toBe(0);
    expect(usage.quotas["gemini-4-argon-high"].remainingPercentage).toBe(0);
    expect(usage.quotas["Gemini (all models)"].remainingPercentage).toBe(0);
    expect(usage.quotas.gemini_argon_weekly).toBeUndefined();
    expect(usage.quotas["Gemini 4 Argon (all models)"]).toBeUndefined();
  });
});

describe("Gemini 4 Neon pricing", () => {
  it("defines MODEL_PRICING entries and pattern fallback for Gemini 4 Neon variants", async () => {
    const { MODEL_PRICING, getPricingForModel } = await import("../../open-sse/providers/pricing.js");

    for (const key of [
      "gemini-4-neon",
      "gemini-4-neon-xhigh",
      "gemini-4-neon-high",
      "gemini-4-neon-medium",
      "gemini-4-neon-low",
      "google/gemini-4-neon",
    ]) {
      expect(MODEL_PRICING[key], key).toMatchObject({
        input: 3.00,
        output: 15.00,
        cached: 0.15,
      });
    }

    for (const [provider, model] of [
      [undefined, "gemini-4-neon"],
      ["antigravity", "gemini-4-neon-xhigh"],
      ["antigravity", "gemini-4-neon-tiered"],
      ["antigravity", "gemini-4-neon-tiered-xhigh"],
      ["nousresearch", "google/gemini-4-neon"],
      [undefined, "google/gemini-4-neon"],
      ["antigravity", "gemini-4-neon-high(high)"],
    ]) {
      const pricing = provider ? getPricingForModel(provider, model) : getPricingForModel(model);
      expect(pricing, `${provider || "canonical"}/${model}`).toMatchObject({
        input: 3.00,
        output: 15.00,
        cached: 0.15,
      });
    }

    // Regression guard: unrelated Gemini models keep their existing pricing
    expect(getPricingForModel("gemini-3-pro-preview").input).toBe(2.00);
    expect(getPricingForModel("gemini-4-hydrogen").input).toBe(0.50);
  });
});
