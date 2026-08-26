import { describe, it, expect } from "vitest";
import agentrouterConfig from "../../open-sse/providers/registry/agentrouter.js";

describe("AgentRouter Model Sync & Fallback Behavior", () => {
  it("provides rich default catalog models in registry", () => {
    expect(agentrouterConfig.models.length).toBeGreaterThanOrEqual(6);
    const modelIds = agentrouterConfig.models.map((m) => m.id);
    expect(modelIds).toContain("claude-opus-4-8");
    expect(modelIds).toContain("claude-3-7-sonnet");
    expect(modelIds).toContain("deepseek-v3");
    expect(modelIds).toContain("gpt-4o");
  });

  it("registers official AgentRouter icon and color", () => {
    expect(agentrouterConfig.display.icon).toBe("agentrouter");
    expect(agentrouterConfig.display.color).toBe("#10B981");
  });
});
