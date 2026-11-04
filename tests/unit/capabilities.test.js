import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });

  it("reports Claude Haiku 5.x as a 1M adaptive-thinking model (not legacy haiku budget)", () => {
    const haiku5Expected = {
      contextWindow: 1000000,
      maxOutput: 128000,
      thinkingFormat: "claude-adaptive",
      reasoning: true,
      vision: true,
      search: true,
    };
    expect(getCapabilitiesForModel("anthropic", "claude-haiku-5-5")).toMatchObject(haiku5Expected);
    expect(getCapabilitiesForModel("anthropic", "claude-haiku-5.5")).toMatchObject(haiku5Expected);
    expect(getCapabilitiesForModel("anthropic", "anthropic/claude-haiku-5-5")).toMatchObject(haiku5Expected);
    // Haiku 4.5 and older stay on the legacy enabled+budget shape.
    expect(getCapabilitiesForModel("anthropic", "claude-haiku-4-5")).toMatchObject({
      contextWindow: 200000,
      thinkingFormat: "claude-budget",
    });
    expect(getCapabilitiesForModel("anthropic", "claude-haiku-4-5-20251001").thinkingFormat).toBe("claude-budget");
  });

  it("reports Claude Fable 5.1 as a permanent adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("claude", "claude-fable-5-1")).toMatchObject({
      ...claudeSonnet5Expected,
      thinkingCanDisable: false,
    });
  });

  it("reports OpenCode space-bunny-free as retired on all tiers (falls to default floor)", () => {
    // space-bunny-free was retired from the opencode FREE tier
    // (HTTP 410 ModelDeprecated, verified live 2026-10-21) and has since been
    // removed from the live Go catalogue as well (2026-11-04). It no longer
    // carries a dedicated opencode-go capability entry, so it resolves to the
    // DEFAULT_CAPABILITIES floor instead of the old 1M/reasoning entry.
    const expected = {
      reasoning: false,
      vision: false,
      contextWindow: 200000,
      maxOutput: 64000,
    };
    expect(getCapabilitiesForModel("opencode-go", "space-bunny-free")).toMatchObject(expected);
  });
});
