// Unit tests for unified thinking normalization (thinkingUnified.js).
// Covers extract, suffix parse, and per-provider apply per MATRIX (.docs/thinking/plan.md).
import { describe, it, expect } from "vitest";
import {
  parseSuffix,
  extractThinking,
  applyThinking,
} from "../../open-sse/translator/concerns/thinkingUnified.js";
import { extractReasoningText } from "../../open-sse/translator/concerns/reasoning.js";

const apply = (targetFormat, model, body, provider) => {
  const b = JSON.parse(JSON.stringify(body));
  applyThinking(targetFormat, model, b, provider);
  return b;
};

describe("parseSuffix", () => {
  it("parses level suffix", () => {
    expect(parseSuffix("gpt-5(high)")).toEqual({ cleanModel: "gpt-5", override: { mode: "level", level: "high" } });
  });
  it("parses numeric budget suffix", () => {
    expect(parseSuffix("model(8192)")).toEqual({ cleanModel: "model", override: { mode: "budget", budget: 8192 } });
  });
  it("parses auto / none", () => {
    expect(parseSuffix("m(auto)").override).toEqual({ mode: "auto" });
    expect(parseSuffix("m(none)").override).toEqual({ mode: "none" });
  });
  it("no suffix → passthrough", () => {
    expect(parseSuffix("claude-opus-4.7")).toEqual({ cleanModel: "claude-opus-4.7", override: null });
  });
});

describe("extractThinking", () => {
  it("claude enabled+budget", () => {
    expect(extractThinking({ thinking: { type: "enabled", budget_tokens: 4096 } })).toEqual({ mode: "budget", budget: 4096 });
  });
  it("claude disabled", () => {
    expect(extractThinking({ thinking: { type: "disabled" } })).toEqual({ mode: "none" });
  });
  it("openai reasoning_effort", () => {
    expect(extractThinking({ reasoning_effort: "high" })).toEqual({ mode: "level", level: "high" });
  });
  it("responses reasoning.effort none", () => {
    expect(extractThinking({ reasoning: { effort: "none" } })).toEqual({ mode: "none" });
  });
  it("gemini thinkingBudget 0 → none", () => {
    expect(extractThinking({ thinkingConfig: { thinkingBudget: 0 } })).toEqual({ mode: "none" });
  });
  it("qwen enable_thinking false", () => {
    expect(extractThinking({ enable_thinking: false })).toEqual({ mode: "none" });
  });
  it("no intent → null", () => {
    expect(extractThinking({ messages: [] })).toBeNull();
  });
});

describe("applyThinking per provider format", () => {
  it("claude 4.6+ → adaptive thinking + output_config (no budget_tokens)", () => {
    const out = apply("claude", "claude-opus-4.7", { reasoning_effort: "high" }, "claude");
    expect(out.output_config).toEqual({ effort: "high" });
    expect(out.thinking).toEqual({ type: "adaptive" });
  });
  it("claude haiku → enabled+budget", () => {
    const out = apply("claude", "claude-haiku-4.5", { reasoning_effort: "high" }, "claude");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
  });
  it("gemini-3 → thinkingLevel", () => {
    const out = apply("gemini", "gemini-3-pro", { reasoning_effort: "medium" }, "gemini");
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });
  it("gemini-3 clamps unsupported max/xhigh thinking levels to high", () => {
    const outMax = apply("gemini", "gemini-3-pro", { reasoning_effort: "max" }, "gemini");
    const outXhigh = apply("gemini", "gemini-3-pro", { reasoning_effort: "xhigh" }, "gemini");
    expect(outMax.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(outXhigh.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });
  it("gemini-3 maps auto thinking level to high instead of sending unsupported auto", () => {
    const out = apply("gemini", "gemini-3-pro", { reasoning_effort: "auto" }, "gemini");
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });
  it("gemini-2.5 → thinkingBudget", () => {
    const out = apply("gemini", "gemini-2.5-flash", { reasoning_effort: "high" }, "gemini");
    expect(out.generationConfig.thinkingConfig.thinkingBudget).toBe(24576);
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined();
  });
  it("GLM off → enable_thinking:false (not thinking.disabled)", () => {
    const out = apply("openai", "glm-4.6", { reasoning_effort: "none" }, "glm");
    expect(out.enable_thinking).toBe(false);
    expect(out.thinking).toBeUndefined();
  });
  it("Qwen on → enable_thinking + thinking_budget", () => {
    const out = apply("openai", "qwen3-max", { reasoning_effort: "medium" }, "qwen");
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBe(8192);
  });
  it("QwQ cannot disable → clamp minimal", () => {
    const out = apply("openai", "qwq-32b", { reasoning_effort: "none" }, "qwen");
    expect(out.enable_thinking).toBe(true);
  });
  it("DeepSeek → enabled + reasoning_effort high (low→high)", () => {
    const out = apply("openai", "deepseek-v4-pro", { reasoning_effort: "low" }, "deepseek");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("high");
  });
  it("Kimi on → reasoning_effort", () => {
    const out = apply("openai", "kimi-k2.6", { reasoning_effort: "high" }, "kimi");
    expect(out.reasoning_effort).toBe("high");
  });
  it("Kimi auto → supported reasoning_effort", () => {
    const out = apply("openai", "kimi-k2.7", { reasoning_effort: "auto" }, "kimchi");
    expect(out.reasoning_effort).toBe("high");
  });
  it("Kimi unsupported OpenAI levels → supported reasoning_effort", () => {
    const minimal = apply("openai", "kimi-k2.7", { reasoning_effort: "minimal" }, "kimchi");
    const xhigh = apply("openai", "kimi-k2.7", { reasoning_effort: "xhigh" }, "kimchi");
    expect(minimal.reasoning_effort).toBe("low");
    expect(xhigh.reasoning_effort).toBe("max");
  });
  it("MiniMax M3 → adaptive", () => {
    const out = apply("claude", "MiniMax-M3", { reasoning_effort: "high" }, "minimax");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });
  it("non-reasoning model → strips thinking", () => {
    const out = apply("openai", "gpt-4o", { reasoning_effort: "high" }, "openai");
    expect(out.reasoning_effort).toBeUndefined();
  });
  it("aggregator (siliconflow) GLM model → forced openai reasoning_effort", () => {
    const out = apply("openai", "zai-org/GLM-5", { reasoning_effort: "high" }, "siliconflow");
    expect(out.reasoning_effort).toBe("high");
    expect(out.enable_thinking).toBeUndefined();
  });
  it("suffix overrides body", () => {
    const out = apply("openai", "gpt-5(low)", { reasoning_effort: "high" }, "openai");
    expect(out.reasoning_effort).toBe("low");
  });
  it("openai keeps xhigh for reasoning models", () => {
    const out = apply("openai", "gpt-5.3-codex", { reasoning_effort: "xhigh" }, "codex");
    expect(out.reasoning_effort).toBe("xhigh");
  });
  it("ultra clamps to xhigh for openai/codex (enum tops at xhigh, not max)", () => {
    const out = apply("openai", "gpt-5.3-codex", { reasoning_effort: "ultra" }, "codex");
    expect(out.reasoning_effort).toBe("xhigh");
  });
  it("ultra clamps to high for claude-adaptive (native enum low/medium/high only)", () => {
    const out = apply("claude", "claude-opus-4.7", { reasoning_effort: "ultra" }, "claude");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });
  it("claude-adaptive minimal maps to low (no silent cost escalation)", () => {
    const out = apply("claude", "claude-opus-4.7", { reasoning_effort: "minimal" }, "claude");
    expect(out.output_config).toEqual({ effort: "low" });
  });
  it("claude-adaptive auto emits no output_config (adaptive decides)", () => {
    const out = apply("claude", "claude-opus-4.7", { output_config: { effort: "auto" } }, "claude");
    expect(out.output_config).toBeUndefined();
  });
  it("ultra never exceeds provider maxOutput on claude-budget", () => {
    const out = apply("claude", "claude-haiku-4.5", { reasoning_effort: "ultra" }, "claude");
    expect(out.thinking.type).toBe("enabled");
    expect(out.thinking.budget_tokens).toBeGreaterThanOrEqual(1);
    expect(out.thinking.budget_tokens).toBeLessThanOrEqual(64000);
  });
  it("ultra clamps to high for gemini-3 (enum minimal/low/medium/high only)", () => {
    const out = apply("gemini", "gemini-3-pro", { reasoning_effort: "ultra" }, "gemini");
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });
  it("ultra maps to max for kimi", () => {
    const out = apply("openai", "kimi-k2.7", { reasoning_effort: "ultra" }, "kimchi");
    expect(out.reasoning_effort).toBe("max");
  });
  it("ultra maps to max for deepseek", () => {
    const out = apply("openai", "deepseek-v4-pro", { reasoning_effort: "ultra" }, "deepseek");
    expect(out.reasoning_effort).toBe("max");
  });
  it("ultra budget in qwen clamps to maxOutput-1024 (62976)", () => {
    const out = apply("openai", "qwen3-coder", { reasoning_effort: "ultra" }, "qwen");
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBe(62976);
  });
  it("ultra budget in hunyuan stays 160000 (under its 262144 maxOutput)", () => {
    const out = apply("openai", "hunyuan-turbos", { reasoning_effort: "ultra" }, "hunyuan");
    expect(out.thinking.type).toBe("enabled");
    expect(out.thinking.budget_tokens).toBe(160000);
  });
  it("ultra clamps to high for step (native enum low/medium/high)", () => {
    const out = apply("openai", "step-2-16k", { reasoning_effort: "ultra" }, "step");
    expect(out.reasoning_effort).toBe("high");
  });
  it("ultra with trailing whitespace still clamps (no raw leak)", () => {
    const out = apply("openai", "gpt-5.3-codex", { reasoning_effort: "ultra " }, "codex");
    expect(out.reasoning_effort).toBe("xhigh");
  });
  it("hermes reasoning.effort ultra shape clamps too", () => {
    // Hermes sends extra_body.reasoning which the OpenAI SDK merges to the
    // top-level body.reasoning = { enabled, effort }. extractThinking reads it.
    const body = { messages: [], reasoning: { enabled: true, effort: "ultra" }, reasoning_effort: "ultra" };
    const intent = extractThinking(body);
    expect(intent).toEqual({ mode: "level", level: "ultra" });
    const out = apply("openai", "gpt-5.3-codex", { ...body }, "codex");
    expect(out.reasoning_effort).toBe("xhigh");
    expect(out.reasoning).toBeUndefined(); // stripAll removed the raw object
  });
  it("ultra preserves answer room on claude-budget (budget == maxOutput-1024)", () => {
    const out = apply("claude", "claude-haiku-4.5", { reasoning_effort: "ultra" }, "claude");
    // Anthropic requires budget_tokens < max_tokens; the 1024 floor matches the
    // reconciler in formats/claude.js:285, so answer room stays >= 1024 tokens.
    expect(out.thinking.budget_tokens).toBe(64000 - 1024);
  });
  it("Fable 5.1 → effort without a redundant thinking switch", () => {
    const out = apply("claude", "claude-fable-5-1", { reasoning_effort: "high" }, "claude");
    expect(out.output_config).toEqual({ effort: "high" });
    expect(out.thinking).toBeUndefined();
  });
  it.each([
    ["gemini-3.5-flash-lite"],
    ["gemini-3.7-flash"],
    ["gemini-3-pro"],
  ])("Gemini 3.x model %s (gemini-level) over a custom OpenAI-compatible provider → reasoning_effort, not generationConfig (regression: #3718)", (model) => {
    const out = apply("openai", model, { reasoning_effort: "medium" }, "my-custom-gemini-openai");
    expect(out.reasoning_effort).toBe("medium");
    expect(out.generationConfig).toBeUndefined();
    expect(out.thinkingConfig).toBeUndefined();
  });
  it("Gemini 2.5 model (gemini-budget) over a custom OpenAI-compatible provider → reasoning_effort, not generationConfig (regression: #3718)", () => {
    const out = apply("openai", "gemini-2.5-flash", { reasoning_effort: "high" }, "my-custom-gemini-openai");
    expect(out.reasoning_effort).toBe("high");
    expect(out.generationConfig).toBeUndefined();
    expect(out.thinkingConfig).toBeUndefined();
  });
  it("Gemini model over its native format (antigravity/gemini-cli/vertex) still gets generationConfig", () => {
    const out = apply("gemini-cli", "gemini-3.5-flash-lite", { reasoning_effort: "medium" }, "gemini-cli");
    expect(out.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });
});

describe("extractReasoningText (response shapes)", () => {
  it("reasoning_content (GLM/Qwen/DeepSeek)", () => {
    expect(extractReasoningText({ reasoning_content: "abc" })).toBe("abc");
  });
  it("reasoning fallback", () => {
    expect(extractReasoningText({ reasoning: "xyz" })).toBe("xyz");
  });
  it("reasoning_details[] (MiniMax split)", () => {
    expect(extractReasoningText({ reasoning_details: [{ text: "a" }, { content: "b" }, "c"] })).toBe("abc");
  });
  it("no reasoning → empty", () => {
    expect(extractReasoningText({ content: "hello" })).toBe("");
  });
});
