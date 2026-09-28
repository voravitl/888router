import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Regression: opencode-go models had no capability entries, so /v1/models fell
// back to the generic default (200k) or picked up unrelated family patterns.
// Contexts evidence: https://opencode.ai/v2/docs/console/go (Go tiers priced by
// context ranges: GPT Luna ≤272K, Grok ≤200K, Qwen Plus ≤256K) + each model's
// public spec mirrored from the same families' entries in this file.
describe("OpenCode Go per-model capabilities", () => {
  const cases = [
    ["glm-5.3-flash", 1000000, 128000, "openai-low-high-max", false],
    ["glm-5.3",       1000000, 128000, "openai-low-high-max", false],
    ["kimi-k3",       1000000, 131072, "openai", true],
    ["kimi-k2.7-code", 256000, 64000, "openai", true],
    ["deepseek-v4-pro", 1000000, 384000, "deepseek", true],
    ["minimax-m3",    512000, 48000, "openai", true],
    ["qwen3.8-max",   256000, 65536, "qwen", true],
    ["grok-4.7",      200000, 64000, "openai", true],
    ["gpt-6-luna",    272000, 64000, "openai", true],
    ["gpt-5.6-luna",  272000, 64000, "openai", true],
    ["longcat-2.0",   200000, 64000, "openai", true],
    ["longcat-2.5-preview-free", 200000, 64000, null, true],
  ];
  for (const [model, ctx, maxOut, tf, canDisable] of cases) {
    it(`${model}: ctx=${ctx} maxOut=${maxOut} tf=${tf}`, () => {
      const c = getCapabilitiesForModel("opencode-go", model);
      expect(c.contextWindow).toBe(ctx);
      expect(c.maxOutput).toBe(maxOut);
      expect(c.thinkingFormat).toBe(tf);
      expect(c.thinkingCanDisable).toBe(canDisable);
    });
  }
});

// buildUrl tier routing: paid muse-spark-contributor must hit /zen/go/v1/responses
// (previously hardcoded to the FREE /zen/v1 base — upstream "Model is unavailable")
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
describe("OpenCode Go buildUrl /responses tier routing", () => {
  it("paid muse-spark-contributor on opencode-go → /zen/go/v1/responses", () => {
    const ex = new OpenCodeExecutor("opencode-go");
    expect(ex.buildUrl("muse-spark-1.3-contributor", true, 0, { apiKey: "oc_sk_test" })).toBe(
      "https://opencode.ai/zen/go/v1/responses",
    );
  });
  it("free muse-spark-contributor-free on opencode-go stays on /zen/v1/responses", () => {
    const ex = new OpenCodeExecutor("opencode-go");
    expect(ex.buildUrl("muse-spark-1.3-contributor-free", true, 0, {})).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });
  it("free tier provider (opencode) keeps /zen/v1/responses", () => {
    const ex = new OpenCodeExecutor("opencode");
    expect(ex.buildUrl("muse-spark-1.3-contributor-free", true, 0, {})).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });
});
