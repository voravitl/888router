// Gemini 4 Argon support on Antigravity (ported contract from upstream 9router
// tests/unit/gemini-4-argon.test.js) + the quota allowlist wiring.
//
// Evidence trail (2026-10-17):
// - upstream decolua/9router antigravity registry: gemini-4-argon-high with
//   upstreamModelId "gemini-4-argon-high(high)" — the parenthetical mirrors
//   config/providerModels.js getModelUpstreamId suffix semantics (thinking level).
// - caps/thinking levels: *gemini-4* pattern (1M ctx / 64k out / gemini-level /
//   canDisable=false) and levels ["low","medium","high"] — argon rejects
//   thinkingLevel "minimal" with HTTP 400, so LOW is the floor.
// - Live Google fetchAvailableModels (pro-tier account, 2026-10-17) lists bare
//   model keys ("gemini-3.8-flash-high" style, no parentheticals) and argon was
//   not listed yet — the quota parse must accept the bare argon key the moment
//   Google's rollout exposes it.
//
// Engine modules are imported dynamically inside tests (same pattern as the
// 3.6 quota suite) so the proxyAwareFetch mock factory is not evaluated before
// its top-level const initializes.
import { describe, expect, it, vi, beforeEach } from "vitest";

// Quota harness — same shape as tests/unit/antigravity-quota-gemini-3.6.test.js.
const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "pro-tier" } }
    : {
        models: {
          "gemini-4-argon-high": {
            displayName: "Gemini 4 Argon (High)",
            quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-18T12:00:00Z" },
          },
          "gemini-3.8-flash-high": {
            displayName: "Gemini 3.8 Flash (High)",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-18T12:00:00Z" },
          },
          "claude-sonnet-5-5-high": {
            displayName: "Claude Sonnet 5.5 (High)",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-18T12:00:00Z" },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Gemini 4 Argon capabilities", () => {
  it.each(["antigravity", "gemini", "vertex"])("declares level-based always-on reasoning on %s", async (provider) => {
    const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");
    const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");

    const model = provider === "antigravity" ? "gemini-4-argon-high" : "gemini-4-argon";
    const caps = getCapabilitiesForModel(provider, model);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(getThinkingLevels(provider, model)).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Argon thinking clamp", () => {
  // Argon rejects thinkingLevel "minimal" (and thinkingBudget) with HTTP 400 —
  // every path that would emit "minimal" must clamp to the lowest supported level.
  it("clamps an explicit reasoning_effort none to low", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("clamps a small thinking budget (minimal after conversion) to low", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const body = { thinking: { type: "enabled", budget_tokens: 512 } };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("passes supported levels through untouched", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const body = { reasoning_effort: "high" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("keeps minimal for Gemini 3 models (regression guard)", async () => {
    const { applyThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-3.8-flash", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: false });
  });
});

describe("Gemini 4 Argon Antigravity tier", () => {
  it("maps the high tier to the wire model with a high thinking level", async () => {
    const { getModelUpstreamId } = await import("../../open-sse/config/providerModels.js");
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { applyThinking, stripThinkingSuffix } = await import("../../open-sse/translator/concerns/thinkingUnified.js");

    const upstreamModel = getModelUpstreamId("ag", "gemini-4-argon-high");
    expect(upstreamModel).toBe("gemini-4-argon-high(high)");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      "gemini-4-argon-high",
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });
});

describe("Antigravity quota: Gemini 4 Argon (High)", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("parses the argon quota bar and rolls it into the Gemini family pool", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-4-argon-high"]).toMatchObject({
      used: 750,
      total: 1000,
      remainingPercentage: 25,
      displayName: "Gemini 4 Argon (High)",
    });
    // Family rollup = tightest member — argon (25%) is the floor, so the
    // pooled row must reflect argon, not the healthier 3.8 Flash member.
    expect(usage.quotas["Gemini (all models)"]).toMatchObject({ remainingPercentage: 25 });
    expect(usage.quotas["Claude (all models)"]).toMatchObject({ remainingPercentage: 90 });
  });
});
