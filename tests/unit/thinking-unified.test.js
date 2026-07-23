import { describe, it, expect } from "vitest";
import { applyThinking, extractThinking, parseSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("thinkingUnified gap-fill normalization", () => {
  it("parses model suffix override correctly", () => {
    const { cleanModel, override } = parseSuffix("claude-sonnet-4.6(high)");
    expect(cleanModel).toBe("claude-sonnet-4.6");
    expect(override).toEqual({ mode: "level", level: "high" });
  });

  it("normalizes Qwen reasoning config", () => {
    const body = { enable_thinking: true, thinking_budget: 4096 };
    const intent = extractThinking(body);
    expect(intent).toEqual({ mode: "budget", budget: 4096 });

    const targetBody = { messages: [] };
    applyThinking("openai", "vision-model", targetBody, null, intent);
    expect(targetBody.enable_thinking).toBe(true);
    expect(targetBody.thinking_budget).toBe(4096);
  });

  it("normalizes Kimi reasoning_effort", () => {
    const body = { reasoning_effort: "high" };
    const intent = extractThinking(body);
    const targetBody = { messages: [] };
    applyThinking("openai", "kimi-k2.7", targetBody, "codebuddy-cn", intent);
    expect(targetBody.reasoning_effort).toBe("high");
  });

  it("strips thinking fields when model does not support reasoning", () => {
    const body = { thinking: { type: "enabled" }, reasoning_effort: "high" };
    applyThinking("openai", "gpt-3.5-turbo", body);
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
