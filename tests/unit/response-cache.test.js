import { describe, it, expect, beforeEach } from "vitest";
import { computeResponseCacheKey, getCachedResponse, setCachedResponse, clearResponseCache, isResponseCacheOptIn, isCacheablePayload } from "../../open-sse/translator/concerns/responseCache.js";

describe("P4/P5: Response Caching Layer (Exact SHA-256)", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  // ── Opt-in contract ──
  describe("isResponseCacheOptIn", () => {
    it("returns false for standard requests without opt-in header", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      expect(isResponseCacheOptIn(body, {})).toBe(false);
    });

    it("returns true when x-888-response-cache: true is set", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };
      expect(isResponseCacheOptIn(body, headers)).toBe(true);
    });

    it("returns true when x-888-response-cache: 1 is set", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "1" };
      expect(isResponseCacheOptIn(body, headers)).toBe(true);
    });

    it("returns true for legacy x-cache-response header", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-cache-response": "true" };
      expect(isResponseCacheOptIn(body, headers)).toBe(true);
    });

    it("returns false for false/0 header values", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      expect(isResponseCacheOptIn(body, { "x-888-response-cache": "false" })).toBe(false);
      expect(isResponseCacheOptIn(body, { "x-888-response-cache": "0" })).toBe(false);
    });
  });

  // ── Cache key computation ──
  describe("computeResponseCacheKey", () => {
    it("computes deterministic SHA-256 cache key", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey(body, "gpt-4o");
      const key2 = computeResponseCacheKey(body, "gpt-4o");
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // SHA-256 hex string
    });

    it("produces the SAME key for different model ids with identical content (cross-model cache, #354)", () => {
      // After #354 the cache key is provider-agnostic: a user A/B-ing the
      // same prompt across Claude / GPT / Gemini hits the same entry.
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey(body, "gpt-4o");
      const key2 = computeResponseCacheKey(body, "claude-sonnet-4");
      expect(key1).toBe(key2);
    });

    it("produces different keys for different messages", () => {
      const key1 = computeResponseCacheKey({ messages: [{ role: "user", content: "hello" }] }, "gpt-4o");
      const key2 = computeResponseCacheKey({ messages: [{ role: "user", content: "goodbye" }] }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different temperature", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey({ ...body, temperature: 0 }, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, temperature: 1 }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different seed", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey({ ...body, seed: 42 }, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, seed: 99 }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different system prompts", () => {
      const body = { messages: [{ role: "user", content: "hello" }], system: "You are helpful" };
      const key1 = computeResponseCacheKey(body, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, system: "You are a poet" }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different tools", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey(body, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, tools: [{ name: "get_weather" }] }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("returns null for null/undefined body", () => {
      expect(computeResponseCacheKey(null, "gpt-4o")).toBeNull();
      expect(computeResponseCacheKey(undefined, "gpt-4o")).toBeNull();
    });

    it("supports Gemini contents array format", () => {
      const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
      const key = computeResponseCacheKey(body, "gemini-2.0-flash");
      expect(key).toHaveLength(64);
    });

    it("supports Anthropic input format", () => {
      const body = { input: [{ role: "user", content: "hello" }] };
      const key = computeResponseCacheKey(body, "claude-sonnet-4");
      expect(key).toHaveLength(64);
    });

    it("produces different keys for different max_tokens", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey({ ...body, max_tokens: 100 }, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, max_tokens: 500 }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different stop sequences", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey({ ...body, stop: ["\n"] }, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, stop: ["."] }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different presence_penalty", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const key1 = computeResponseCacheKey({ ...body, presence_penalty: 0 }, "gpt-4o");
      const key2 = computeResponseCacheKey({ ...body, presence_penalty: 1 }, "gpt-4o");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for different Gemini systemInstruction", () => {
      const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
      const key1 = computeResponseCacheKey({ ...body, systemInstruction: "You are helpful" }, "gemini-2.0-flash");
      const key2 = computeResponseCacheKey({ ...body, systemInstruction: "You are a poet" }, "gemini-2.0-flash");
      expect(key1).not.toBe(key2);
    });

    it("handles Gemini systemInstruction as object", () => {
      const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "Be concise" }] } };
      const key = computeResponseCacheKey(body, "gemini-2.0-flash");
      expect(key).toHaveLength(64);
    });
  });

  // ── Cacheable payload checks ──
  describe("isCacheablePayload", () => {
    it("returns false for streaming requests", () => {
      expect(isCacheablePayload({ stream: true })).toBe(false);
    });

    it("returns false for tool-using requests", () => {
      expect(isCacheablePayload({ tools: [{ name: "get_weather" }] })).toBe(false);
    });

    it("returns false when tool_choice is set to non-none value", () => {
      expect(isCacheablePayload({ tool_choice: "auto" })).toBe(false);
      expect(isCacheablePayload({ tool_choice: "any" })).toBe(false);
    });

    it("returns true when tool_choice is none", () => {
      expect(isCacheablePayload({ tool_choice: "none" })).toBe(true);
    });

    it("returns false for null/undefined body", () => {
      expect(isCacheablePayload(null)).toBe(false);
      expect(isCacheablePayload(undefined)).toBe(false);
    });

    it("returns true for plain Q&A requests", () => {
      expect(isCacheablePayload({ messages: [{ role: "user", content: "hello" }] })).toBe(true);
    });

    it("returns false when response contains tool_calls", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const response = { choices: [{ message: { tool_calls: [{ id: "call_1" }] } }] };
      expect(isCacheablePayload(body, response)).toBe(false);
    });

    it("returns false when response delta contains tool_calls", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const response = { choices: [{ delta: { tool_calls: [{ id: "call_1" }] } }] };
      expect(isCacheablePayload(body, response)).toBe(false);
    });
  });

  // ── Cache store and retrieve ──
  describe("getCachedResponse / setCachedResponse", () => {
    it("stores and retrieves cached response on opt-in cache hit", () => {
      const body = { messages: [{ role: "user", content: "what is 2+2?" }] };
      const headers = { "x-888-response-cache": "true" };
      const fakeResponse = { id: "chatcmpl-123", choices: [{ message: { content: "4" } }] };

      setCachedResponse(body, "gpt-4o", fakeResponse, headers);

      const hit = getCachedResponse(body, "gpt-4o", headers);
      expect(hit).not.toBeNull();
      expect(hit.hit).toBe(true);
      expect(hit.cachedResponse).toEqual(fakeResponse);
    });

    it("returns null on cache miss (no opt-in)", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const fakeResponse = { choices: [{ message: { content: "hi" } }] };

      setCachedResponse(body, "gpt-4o", fakeResponse, { "x-888-response-cache": "true" });
      const miss = getCachedResponse(body, "gpt-4o", {}); // no opt-in
      expect(miss).toBeNull();
    });

    it("returns a hit on cache match (different model, identical content — #354)", () => {
      // After #354 the cache is provider-agnostic; the same body cached
      // under one model id hits under any other.
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };

      setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      const hit = getCachedResponse(body, "claude-sonnet-4", headers);
      expect(hit).not.toBeNull();
      expect(hit.hit).toBe(true);
    });

    it("returns null on cache miss (different message)", () => {
      const headers = { "x-888-response-cache": "true" };

      setCachedResponse({ messages: [{ role: "user", content: "hello" }] }, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      const miss = getCachedResponse({ messages: [{ role: "user", content: "world" }] }, "gpt-4o", headers);
      expect(miss).toBeNull();
    });

    it("returns null when setCachedResponse is called without opt-in", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const result = setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, {});
      expect(result).toBe(false);

      const miss = getCachedResponse(body, "gpt-4o", { "x-888-response-cache": "true" });
      expect(miss).toBeNull();
    });

    it("returns null when setCachedResponse is called with streaming body", () => {
      const body = { messages: [{ role: "user", content: "hello" }], stream: true };
      const headers = { "x-888-response-cache": "true" };
      const result = setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      expect(result).toBe(false);
    });

    it("returns null when setCachedResponse is called with tools", () => {
      const body = { messages: [{ role: "user", content: "hello" }], tools: [{ name: "get_weather" }] };
      const headers = { "x-888-response-cache": "true" };
      const result = setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      expect(result).toBe(false);
    });

    it("returns null when response contains tool_calls (setCachedResponse)", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };
      const response = { choices: [{ message: { tool_calls: [{ id: "call_1", function: { name: "x", arguments: "{}" } }] } }] };
      const result = setCachedResponse(body, "gpt-4o", response, headers);
      expect(result).toBe(false);
    });

    it("returns null when payload exceeds 500KB", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };
      // Create a response payload > 500KB
      const largeContent = "x".repeat(600 * 1024);
      const largeResponse = { choices: [{ message: { content: largeContent } }] };
      const result = setCachedResponse(body, "gpt-4o", largeResponse, headers);
      expect(result).toBe(false);
    });

    it("returns deep-cloned response (mutation-safe)", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };
      const response = { choices: [{ message: { content: "original" } }] };

      setCachedResponse(body, "gpt-4o", response, headers);
      const hit = getCachedResponse(body, "gpt-4o", headers);

      // Mutate original — cached copy should be unaffected
      response.choices[0].message.content = "mutated";
      expect(hit.cachedResponse.choices[0].message.content).toBe("original");
    });

    it("returns cacheKey in hit result", () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };

      setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      const hit = getCachedResponse(body, "gpt-4o", headers);
      expect(hit.cacheKey).toHaveLength(64);
    });
  });

  // ── LRU eviction ──
  describe("LRU eviction", () => {
    it("evicts oldest entry when cache exceeds MAX_CACHE_ENTRIES (500)", () => {
      const headers = { "x-888-response-cache": "true" };
      const model = "gpt-4o";

      // Fill cache with 500 entries (0-499) — Map now has 500 entries
      for (let i = 0; i < 500; i++) {
        const body = { messages: [{ role: "user", content: `msg-${i}` }] };
        setCachedResponse(body, model, { choices: [{ message: { content: `reply-${i}` } }] }, headers);
      }

      // Insert 1 more (entry 500) — triggers eviction of oldest (entry 0)
      const body500 = { messages: [{ role: "user", content: "msg-500" }] };
      setCachedResponse(body500, model, { choices: [{ message: { content: "reply-500" } }] }, headers);

      // Entry 0 should be evicted (oldest)
      const body0 = { messages: [{ role: "user", content: "msg-0" }] };
      const miss = getCachedResponse(body0, model, headers);
      expect(miss).toBeNull();

      // Entry 500 should be present (newest)
      const hit = getCachedResponse(body500, model, headers);
      expect(hit).not.toBeNull();
      expect(hit.hit).toBe(true);
    });

    it("refreshes LRU order on cache hit", () => {
      const headers = { "x-888-response-cache": "true" };
      const model = "gpt-4o";

      // Insert 3 entries (0, 1, 2) — Map order: [0, 1, 2]
      for (let i = 0; i < 3; i++) {
        const body = { messages: [{ role: "user", content: `msg-${i}` }] };
        setCachedResponse(body, model, { choices: [{ message: { content: `reply-${i}` } }] }, headers);
      }

      // Hit entry 0 (oldest) — refreshes LRU: Map order becomes [1, 2, 0]
      const body0 = { messages: [{ role: "user", content: "msg-0" }] };
      getCachedResponse(body0, model, headers);

      // Fill to 500 entries (3-500 = 498 entries)
      // First eviction fires when inserting entry 500 (size was 500): removes oldest = entry 1
      for (let i = 3; i <= 500; i++) {
        const body = { messages: [{ role: "user", content: `msg-${i}` }] };
        setCachedResponse(body, model, { choices: [{ message: { content: `reply-${i}` } }] }, headers);
      }

      // Entry 1 should be evicted (oldest after refresh)
      const body1 = { messages: [{ role: "user", content: "msg-1" }] };
      const miss = getCachedResponse(body1, model, headers);
      expect(miss).toBeNull();

      // Entry 0 should still be present (refreshed — not oldest)
      const hit = getCachedResponse(body0, model, headers);
      expect(hit).not.toBeNull();
    });
  });

  // ── TTL expiry ──
  describe("TTL expiry", () => {
    it("returns null for expired entries (TTL = 1 hour)", async () => {
      const body = { messages: [{ role: "user", content: "hello" }] };
      const headers = { "x-888-response-cache": "true" };

      setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);

      // Simulate time travel by manipulating Date.now
      const RealDateNow = Date.now;
      try {
        Date.now = () => RealDateNow() + 3601 * 1000; // 1h + 1s
        const hit = getCachedResponse(body, "gpt-4o", headers);
        expect(hit).toBeNull();
      } finally {
        Date.now = RealDateNow;
      }
    });
  });

  // ── clearResponseCache ──
  describe("clearResponseCache", () => {
    it("clears all cached entries", () => {
      const headers = { "x-888-response-cache": "true" };
      const body = { messages: [{ role: "user", content: "hello" }] };

      setCachedResponse(body, "gpt-4o", { choices: [{ message: { content: "hi" } }] }, headers);
      clearResponseCache();

      const hit = getCachedResponse(body, "gpt-4o", headers);
      expect(hit).toBeNull();
    });
  });
});
