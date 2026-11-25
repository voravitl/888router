import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_IDE_USER_AGENT } from "../../open-sse/providers/shared.js";
import antigravityConfig from "../../open-sse/providers/registry/antigravity.js";
import { AntigravityExecutor, sanitizeAntigravityPrompt, paceAntigravityRequest } from "../../open-sse/executors/antigravity.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { resolveAntigravityCarbonModel, parseAntigravityLiveModels } from "../../open-sse/providers/models/helpers.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { MODEL_PRICING, getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("Antigravity Anti-Ban Hardening (v0.15.273)", () => {
  it("uses live Antigravity Desktop Hub 2.35.0 User-Agent and preserves 429 retry limit of 6", () => {
    expect(ANTIGRAVITY_IDE_VERSION).toBe("2.35.0");
    expect(ANTIGRAVITY_IDE_USER_AGENT).toBe("antigravity/hub/2.35.0 darwin/arm64");
    expect(antigravityConfig.transport.retry["429"].attempts).toBe(6);
    const headers = new AntigravityExecutor().buildHeaders({ accessToken: "tok" });
    expect(headers["User-Agent"]).toBe("antigravity/hub/2.35.0 darwin/arm64");
  });

  it("sanitizeAntigravityPrompt strips OpenCode, Cline, and Cursor self-ID lines without breaking normal prose", () => {
    expect(sanitizeAntigravityPrompt("You are an AI agent running in OpenCode, a coding agent harness. Help the user.")).toBe(
      "You are an AI coding assistant. Help the user."
    );
    expect(sanitizeAntigravityPrompt("You are OpenCode, the best coding agent on the planet. Start now.")).toBe(
      "You are an AI coding assistant. Start now."
    );
    expect(sanitizeAntigravityPrompt("You are Cline, a highly skilled software engineer with deep knowledge.")).toBe(
      "You are a highly skilled software engineer with deep knowledge."
    );
    expect(
      sanitizeAntigravityPrompt("You are a powerful agentic AI coding assistant, powered by Claude. You operate exclusively in Cursor, the AI editor. Be fast.")
    ).toBe("You are an AI coding assistant. Be fast.");

    // Normal prose discussing those tools must stay untouched
    const prose = "The user is debugging OpenCode and Cursor settings in Cline docs.";
    expect(sanitizeAntigravityPrompt(prose)).toBe(prose);
  });

  it("paceAntigravityRequest staggers concurrent calls on the same account while allowing distinct accounts concurrently", async () => {
    const k1 = `acct-a-${Date.now()}`;
    const k2 = `acct-b-${Date.now()}`;

    const starts = [];
    await Promise.all([
      paceAntigravityRequest(k1, { minSpacingMs: 50, jitterMs: 0 }).then(() => starts.push({ k: "a1", t: Date.now() })),
      paceAntigravityRequest(k1, { minSpacingMs: 50, jitterMs: 0 }).then(() => starts.push({ k: "a2", t: Date.now() })),
      paceAntigravityRequest(k2, { minSpacingMs: 50, jitterMs: 0 }).then(() => starts.push({ k: "b1", t: Date.now() })),
    ]);

    const a1 = starts.find((s) => s.k === "a1");
    const a2 = starts.find((s) => s.k === "a2");
    const b1 = starts.find((s) => s.k === "b1");

    expect(a2.t - a1.t).toBeGreaterThanOrEqual(40);
    // Distinct account k2 shouldn't be blocked by k1's spacing window
    expect(Math.abs(b1.t - a1.t)).toBeLessThan(35);
  });
});

describe("Gemini 4 Carbon Full Parity", () => {
  it("registers gemini-4-carbon tiers (low/medium/high) without xhigh and resolves upstream IDs", () => {
    const ids = antigravityConfig.models.map((m) => m.id);
    expect(ids).toContain("gemini-4-carbon");
    expect(ids).toContain("gemini-4-carbon-high");
    expect(ids).toContain("gemini-4-carbon-medium");
    expect(ids).toContain("gemini-4-carbon-low");
    expect(ids).not.toContain("gemini-4-carbon-xhigh");

    expect(resolveAntigravityCarbonModel("gemini-4-carbon")).toBe("gemini-4-carbon-high(high)");
    expect(resolveAntigravityCarbonModel("gemini-4-carbon-medium")).toBe("gemini-4-carbon-medium(medium)");
    expect(resolveAntigravityCarbonModel("gemini-4-carbon-tiered-low")).toBe("gemini-4-carbon-low(low)");

    expect(getModelUpstreamId("ag", "gemini-4-carbon")).toBe("gemini-4-carbon-high(high)");
    expect(getModelUpstreamId("ag", "gemini-4-carbon-medium")).toBe("gemini-4-carbon-medium(medium)");
  });

  it("expands gemini-4-carbon-tiered live models without xhigh", () => {
    const parsed = parseAntigravityLiveModels({
      models: { "gemini-4-carbon-tiered": { displayName: "Gemini 4 Carbon" } },
    });
    const ids = parsed.map((m) => m.id);
    expect(ids).toEqual([
      "gemini-4-carbon",
      "gemini-4-carbon-high",
      "gemini-4-carbon-medium",
      "gemini-4-carbon-low",
    ]);
    expect(ids).not.toContain("gemini-4-carbon-xhigh");
  });

  it("configures Gemini 4 Pro capabilities, thinking levels, and pricing for gemini-4-carbon", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-4-carbon-medium");
    expect(caps.vision).toBe(true);
    expect(caps.pdf).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.maxOutput).toBe(262144);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);

    expect(getThinkingLevels("antigravity", "gemini-4-carbon-medium")).toEqual(["low", "medium", "high"]);

    expect(MODEL_PRICING["gemini-4-carbon"]).toBeDefined();
    expect(MODEL_PRICING["gemini-4-carbon-medium"]).toBeDefined();
    const p = getPricingForModel("antigravity", "gemini-4-carbon-medium");
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(p.input);
  });
});
