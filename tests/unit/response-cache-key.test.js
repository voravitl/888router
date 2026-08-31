import { describe, it, expect } from "vitest";
import { computeResponseCacheKey, setCachedResponse, getCachedResponse } from "open-sse/translator/concerns/responseCache.js";

const baseBody = {
  messages: [
    { role: "user", content: "Hello" },
  ],
  temperature: 0.7,
  max_tokens: 256,
};

describe("responseCache (closes #354 cross-model cache fix)", () => {
  it("returns the same key for the same messages under different model ids", () => {
    // The bug: switching model id was the first segment of the cache key,
    // so a 9-free combo that toggles between minimax/minimax-m3:free and a
    // fallback provider re-fetched the entire conversation from cold cache
    // even though the input bytes were identical.
    const a = computeResponseCacheKey(baseBody, "anthropic/claude-sonnet-4-6");
    const b = computeResponseCacheKey(baseBody, "gpt-4o");
    const c = computeResponseCacheKey(baseBody, "gemini/gemini-3-pro");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns the same key when the request shape is identical even with different system prompts", () => {
    // system is already in the key, but model is dropped → cross-provider A/B
    // still collapses on identical content.
    const a = computeResponseCacheKey(
      { ...baseBody, system: "be terse" },
      "anthropic/claude-sonnet-4-6"
    );
    const b = computeResponseCacheKey(
      { ...baseBody, system: "be terse" },
      "gpt-4o"
    );
    expect(a).toBe(b);
  });

  it("returns different keys for different cacheClass buckets (tool vs plain vs structured)", () => {
    const plain = computeResponseCacheKey(baseBody, "anthropic/claude-sonnet-4-6");
    const tool = computeResponseCacheKey(
      { ...baseBody, tools: [{ type: "function", function: { name: "f" } }] },
      "anthropic/claude-sonnet-4-6"
    );
    const structured = computeResponseCacheKey(
      { ...baseBody, response_format: { type: "json_object" } },
      "anthropic/claude-sonnet-4-6"
    );
    expect(plain).not.toBe(tool);
    expect(plain).not.toBe(structured);
    expect(tool).not.toBe(structured);
  });

  it("exercises the full LRU getCachedResponse / setCachedResponse round trip with a model-switched key", async () => {
    // The headline scenario from #354: a user asks the same question, the
    // combo picks model A, fails over to model B, then model C — and the
    // gateway must reuse the cached response on the third attempt. The
    // response cache is opt-in via the `x-888-response-cache: true`
    // header (see `isResponseCacheOptIn`).
    const headers = { "x-888-response-cache": "true" };
    setCachedResponse(baseBody, "anthropic/claude-sonnet-4-6", {
      choices: [{ message: { role: "assistant", content: "world" } }],
    }, headers);
    const hit = getCachedResponse(baseBody, "openai/gpt-4o", headers);
    expect(hit).not.toBeNull();
    expect(hit.hit).toBe(true);
    expect(hit.cachedResponse.choices[0].message.content).toBe("world");
  });
});
