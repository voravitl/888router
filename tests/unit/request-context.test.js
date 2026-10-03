import { describe, it, expect } from "vitest";
import { estimateRequestTokens, getContextFit, getDeclaredModelLimits } from "../../open-sse/services/requestContext.js";
import { registerDynamicCapabilitiesScoped } from "../../open-sse/providers/capabilities.js";

describe("provider-agnostic request context", () => {
  it.each([
    { messages: [{ role: "user", content: "x".repeat(2000000) }] },
    { input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(2000000) }] }] },
    { contents: [{ role: "user", parts: [{ text: "x".repeat(2000000) }] }] },
  ])("counts large input in each supported conversation format", (body) => {
    expect(estimateRequestTokens(body)).toBeGreaterThanOrEqual(500000);
    expect(estimateRequestTokens(body)).toBeLessThan(501000);
  });

  it("includes instructions, structured tool schemas/results and multilingual text", () => {
    expect(estimateRequestTokens({ instructions: "ก".repeat(1000), tools: [{ name: "diagnostic", parameters: { properties: { value: { type: "integer" } } } }], input: [{ type: "function_call_output", output: "z".repeat(4000) }] })).toBeGreaterThan(2000);
  });

  it("does not mistake tool argument keys for encoded media", () => {
    expect(estimateRequestTokens({ input: [{ type: "function_call", arguments: {
      source: "x".repeat(2000000), signature: "ก".repeat(1000),
    } }] })).toBeGreaterThan(501000);
  });

  it("counts translated Kiro history and structured output schemas before choosing a wait budget", () => {
    const text = "x".repeat(2000000);
    expect(estimateRequestTokens({ conversationState: { currentMessage: { userInputMessage: { content: text } } } })).toBeGreaterThanOrEqual(500000);
    expect(estimateRequestTokens({ response_format: { type: "json_schema", json_schema: { schema: { description: text } } } })).toBeGreaterThanOrEqual(500000);
    expect(estimateRequestTokens({ text: { format: { type: "json_schema", schema: { description: text } } } })).toBeGreaterThanOrEqual(500000);
    expect(estimateRequestTokens({ generationConfig: { responseSchema: { description: text } } })).toBeGreaterThanOrEqual(500000);
  });

  it("excludes encoded OpenAI files while retaining similarly named tool arguments", () => {
    const data = "A".repeat(2000000);
    expect(estimateRequestTokens({ input: [{ type: "input_file", file_data: data }] })).toBeLessThan(100);
    expect(estimateRequestTokens({ messages: [{ role: "user", content: [{ type: "file", file: { filename: "x.pdf", file_data: data } }] }] })).toBeLessThan(100);
    expect(estimateRequestTokens({ input: [{ type: "function_call", arguments: { file_data: data } }] })).toBeGreaterThanOrEqual(500000);
  });

  it("uses provider-scoped live limits rather than the default context floor", () => {
    registerDynamicCapabilitiesScoped("context-test-a", "shared", { contextWindow: 1000, maxOutput: 100 });
    registerDynamicCapabilitiesScoped("context-test-b", "shared", { contextWindow: 10000, maxOutput: 1000 });
    const body = { messages: [{ role: "user", content: "x".repeat(6000) }], max_tokens: 50 };
    expect(getContextFit(body, "context-test-a/shared").fits).toBe(false);
    expect(getContextFit(body, "context-test-b/shared").fits).toBe(true);
    expect(getContextFit(body, "context-test-c/unpublished-future-model").fits).toBe(null);
    expect(getDeclaredModelLimits("context-test-c/unpublished-future-model").contextWindow).toBeUndefined();
  });

  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens"])("reserves %s without clamping or mutating the request", (field) => {
    registerDynamicCapabilitiesScoped("context-test-output", "model", { contextWindow: 1000, maxOutput: 500 });
    const body = { input: "x".repeat(2400), [field]: 450 };
    const before = structuredClone(body);
    expect(getContextFit(body, "context-test-output/model").reason).toBe("context_length_exceeded");
    expect(body).toEqual(before);
    expect(getContextFit({ [field]: 501 }, "context-test-output/model").reason).toBe("output_limit_exceeded");
  });

  it("reserves Gemini generation output and does not mistake [1m] for a model capability", () => {
    registerDynamicCapabilitiesScoped("context-test-gemini", "model", { contextWindow: 1000, maxOutput: 200 });
    expect(getContextFit({ contents: [{ parts: [{ text: "x".repeat(3600) }] }], generationConfig: { maxOutputTokens: 150 } }, "context-test-gemini/model[1m]").fits).toBe(false);
  });
});
