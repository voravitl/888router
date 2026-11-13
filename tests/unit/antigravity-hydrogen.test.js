import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "pro-tier" } }
    : {
        models: {
          "gemini-4-hydrogen": {
            displayName: "Gemini 4 Hydrogen",
            quotaInfo: { remainingFraction: 0.65, resetTime: "2026-11-14T12:00:00Z" },
          },
          "gemini-4-argon-high": {
            displayName: "Gemini 4 Argon (High)",
            quotaInfo: { remainingFraction: 0.25, resetTime: "2026-11-14T12:00:00Z" },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Gemini 4 Hydrogen capabilities and thinking levels", () => {
  it.each(["antigravity", "gemini", "vertex"])("exposes low/medium/high/xhigh on %s", async (provider) => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");

    const caps = getCapabilitiesForModel(provider, "gemini-4-hydrogen");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels(provider, "gemini-4-hydrogen")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("keeps Gemini 4 Argon capped at high without xhigh", async () => {
    const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
    expect(getThinkingLevels("antigravity", "gemini-4-argon-high")).toEqual(["low", "medium", "high"]);
  });

  it("preserves xhigh thinkingLevel for gemini-4-hydrogen while clamping Argon xhigh to high", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const h2Body = { reasoning_effort: "xhigh" };
    applyThinking("antigravity", "gemini-4-hydrogen", h2Body, "antigravity");
    expect(h2Body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "xhigh", includeThoughts: true });

    const argonBody = { reasoning_effort: "xhigh" };
    applyThinking("antigravity", "gemini-4-argon-high", argonBody, "antigravity");
    expect(argonBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });

  it("clamps none/minimal to low for gemini-4-hydrogen", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-hydrogen", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });
});

describe("Gemini 4 Hydrogen Antigravity registry & Hub 2.31.2 transport", () => {
  it("maps hydrogen and hydrogen-xhigh to wire model gemini-4-hydrogen with expected thinkingLevel", async () => {
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { applyThinking, stripThinkingSuffix } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    expect(getModelUpstreamId("ag", "gemini-4-hydrogen")).toBe("gemini-4-hydrogen(high)");
    expect(getModelUpstreamId("ag", "gemini-4-hydrogen-xhigh")).toBe("gemini-4-hydrogen(xhigh)");

    const upstream = getModelUpstreamId("ag", "gemini-4-hydrogen-xhigh");
    const body = {
      model: stripThinkingSuffix(upstream),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };
    applyThinking("antigravity", upstream, body, "antigravity");

    const executor = new AntigravityExecutor();
    const finalBody = executor.transformRequest(upstream, body, true, { projectId: "project" });
    expect(finalBody.model).toBe("gemini-4-hydrogen");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });

    const headers = executor.buildHeaders({ accessToken: "fixture-token" });
    expect(headers["User-Agent"]).toBe("antigravity/hub/2.31.2 darwin/arm64");
  });
});

describe("Antigravity quota: Gemini 4 Hydrogen", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("tracks gemini-4-hydrogen quota in quotas and Gemini family rollup", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");
    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-4-hydrogen"]).toMatchObject({
      used: 350,
      total: 1000,
      remainingPercentage: 65,
      displayName: "Gemini 4 Hydrogen",
    });
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({
      remainingPercentage: 65,
      memberCount: 1,
    });
  });
});
