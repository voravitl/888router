import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleComboChat, clearComboKnownUnavailable } from "../../open-sse/services/combo.js";

beforeEach(() => clearComboKnownUnavailable());
afterEach(() => clearComboKnownUnavailable());
import { estimateRequestTokens, getContextFit } from "../../open-sse/services/requestContext.js";
import { registerDynamicCapabilitiesScoped, __resetScopedDynamicCache } from "../../open-sse/providers/capabilities.js";

const log = { info: vi.fn(), warn: vi.fn() };
const longText = "x".repeat(2000000);
const formats = [
  ["OpenAI messages", { messages: [{ role: "user", content: longText }], max_completion_tokens: 8000 }],
  ["Responses input", { input: [{ role: "user", content: [{ type: "input_text", text: longText }] }], max_output_tokens: 8000 }],
  ["Gemini contents", { contents: [{ role: "user", parts: [{ text: longText }] }], generationConfig: { maxOutputTokens: 8000 } }],
  ["Claude messages", { messages: [{ role: "user", content: [{ type: "text", text: longText }] }], max_tokens: 8000 }],
];

describe("500k synthetic routing with real catalogue and estimator", () => {
  it("falls back across providers on an authoritative input-size error without changing history", async () => {
    const body = { messages: [{ role: "user", content: "original context" }], max_tokens: 128 };
    const before = structuredClone(body);
    const single = vi.fn(async (_body, model) => model.startsWith("kiro/")
      ? new Response(JSON.stringify({ error: { message: "content_length_exceeds_threshold" } }), { status: 400, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["kiro/claude-opus-5.5", "google/gemini-2.5-pro"], handleSingleModel: single, log });
    expect(response.status).toBe(200);
    expect(single.mock.calls.map(call => call[1])).toEqual(["kiro/claude-opus-5.5", "google/gemini-2.5-pro"]);
    expect(body).toEqual(before);
  });
  it.each(["saved-large-model-alias", "custom-node/gpt-4o"])("resolves %s before applying provider-specific capacity ordering", async (requestedModel) => {
    registerDynamicCapabilitiesScoped("openai-compatible-long-test", "gpt-4o", { contextWindow: 1000000, maxOutput: 64000 });
    try {
      const body = { messages: [{ role: "user", content: "x".repeat(1200000) }], max_tokens: 8000 };
      const resolveModelInfo = vi.fn(async (model) => model === requestedModel
        ? { provider: "openai-compatible-long-test", model: "gpt-4o" }
        : { provider: "google", model: "gemini-2.5-pro" });
      const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "complete" } }] }), { headers: { "content-type": "application/json" } }));
      const response = await handleComboChat({ body, models: [requestedModel, "google/gemini-2.5-pro"], resolveModelInfo, handleSingleModel: single, log });
      expect(response.status).toBe(200);
      expect(single.mock.calls[0][1]).toBe(requestedModel);
      expect(resolveModelInfo).toHaveBeenCalledWith(requestedModel);
    } finally { __resetScopedDynamicCache(); }
  });
  it.each(formats)("%s past the smallest member's window is rejected instead of rolling onto the larger member", async (_format, body) => {
    expect(estimateRequestTokens(body)).toBeGreaterThanOrEqual(500000);
    expect(getContextFit(body, "openai/gpt-4o").fits).toBe(false);
    const before = structuredClone(body);
    const handleSingleModel = vi.fn();
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "google/gemini-2.5-pro"], handleSingleModel, autoSwitch: false, log });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe("context_length_exceeded");
    // Anthropic wording so Claude Code recognises it and compacts.
    expect(payload.error.message).toMatch(/^prompt is too long: \d+ tokens > 128000 maximum/);
    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(body).toEqual(before);
  });
  it("still serves a combo whose members share one window, leaving the limit to the upstream", async () => {
    const body = { messages: [{ role: "user", content: "x".repeat(130000 * 4) }], max_tokens: 2000 };
    const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "openai/gpt-4o"], handleSingleModel: single, log });
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalledTimes(1);
  });
  it("routes a request inside the 10% estimate margin instead of rejecting it", async () => {
    // ~135k estimated + 2000 reserved: over gpt-4o's 128k, under 128k × 1.1.
    const body = { messages: [{ role: "user", content: "x".repeat(135000 * 4) }], max_tokens: 2000 };
    const total = estimateRequestTokens(body) + 2000;
    expect(total).toBeGreaterThan(128000);
    expect(total).toBeLessThan(128000 * 1.1);
    const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "google/gemini-2.5-pro"], handleSingleModel: single, autoSwitch: false, log });
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalled();
  });
  it("routes a Thai payload inside the margin even though the estimator counts ~1 token per Thai char", async () => {
    const thai = "สวัสดีครับ ช่วยตรวจสอบโค้ดนี้หน่อย ".repeat(3950);
    const body = { messages: [{ role: "user", content: thai }], max_tokens: 2000 };
    const total = estimateRequestTokens(body) + 2000;
    expect(total).toBeGreaterThan(128000);
    expect(total).toBeLessThan(128000 * 1.1);
    const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "google/gemini-2.5-pro"], handleSingleModel: single, autoSwitch: false, log });
    expect(response.status).toBe(200);
    expect(single).toHaveBeenCalled();
  });
  it("still rejects a Thai payload well past the margin", async () => {
    const thai = "สวัสดีครับ ช่วยตรวจสอบโค้ดนี้หน่อย ".repeat(6000);
    const body = { messages: [{ role: "user", content: thai }], max_tokens: 2000 };
    expect(estimateRequestTokens(body) + 2000).toBeGreaterThan(128000 * 1.1);
    const single = vi.fn();
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "google/gemini-2.5-pro"], handleSingleModel: single, autoSwitch: false, log });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("context_length_exceeded");
    expect(single).not.toHaveBeenCalled();
  });
  it("serves a request under the smallest member's window from the combo's own order", async () => {
    const body = { messages: [{ role: "user", content: "short" }], max_tokens: 128 };
    const single = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["openai/gpt-4o", "google/gemini-2.5-pro"], handleSingleModel: single, autoSwitch: false, log });
    expect(response.status).toBe(200);
    expect(single.mock.calls[0][1]).toBe("openai/gpt-4o");
  });
  it("lets the upstream decide when only the approximate context estimate is oversized", async () => {
    const body = { messages: [{ role: "user", content: "x".repeat(127000 * 4) }], max_tokens: 2000 };
    const single = vi.fn(async () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "Upstream context limit" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const response = await handleComboChat({ body, models: ["openai/gpt-4o"], handleSingleModel: single, log });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("Upstream context limit");
    expect(single).toHaveBeenCalledTimes(1);
  });
});
