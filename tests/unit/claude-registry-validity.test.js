import { describe, expect, it } from "vitest";
import { isValidModel } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Claude OAuth registry additions", () => {
  it.each([
    ["claude-opus-5", "claude-adaptive", 1000000, 128000],
    ["claude-opus-5-5", "claude-adaptive", 1000000, 128000],
    ["claude-sonnet-4-6", "claude-adaptive", 1000000, 128000],
    ["claude-sonnet-5-5", "claude-adaptive", 1000000, 128000],
    ["claude-fable-5-1", "claude-adaptive", 1000000, 128000],
    ["claude-opus-4-6", "claude-adaptive", 1000000, 128000],
    ["claude-opus-4-5-20251101", "claude-budget", 200000, 64000],
  ])("resolves cc/%s with its existing native capabilities", (model, thinkingFormat, contextWindow, maxOutput) => {
    expect(isValidModel("cc", model)).toBe(true);
    expect(getCapabilitiesForModel("claude", model)).toMatchObject({
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat,
      contextWindow,
      maxOutput,
    });
  });
});
