import { describe, it, expect } from "vitest";
import { SSE_HEADERS, SSE_HEADERS_CORS, SSE_HEADERS_NO_BUFFER } from "../../open-sse/utils/sseConstants.js";
import { stripPrivateToolFields } from "../../open-sse/translator/concerns/universalToolPrompt.js";
import { isResponseCacheOptIn } from "../../open-sse/translator/concerns/responseCache.js";

describe("Performance & Latency Optimizations", () => {
  it("SSE headers contain X-Accel-Buffering: no to disable Nginx Ingress buffering", () => {
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
    expect(SSE_HEADERS_CORS["X-Accel-Buffering"]).toBe("no");
    expect(SSE_HEADERS_NO_BUFFER["X-Accel-Buffering"]).toBe("no");
  });

  it("stripPrivateToolFields is pure and immutable without mutating original body", () => {
    const original = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      _universalToolPromptInjected: true,
      _declaredTools: [{ name: "calc" }]
    };

    const stripped = stripPrivateToolFields(original);
    expect(stripped.model).toBe("gpt-4o");
    expect(stripped._universalToolPromptInjected).toBeUndefined();
    expect(stripped._declaredTools).toBeUndefined();

    // Verify original object was NOT mutated
    expect(original._universalToolPromptInjected).toBe(true);
    expect(original._declaredTools).toHaveLength(1);
  });

  it("isResponseCacheOptIn only returns true when opt-in header is explicitly set", () => {
    expect(isResponseCacheOptIn({}, {})).toBe(false);
    expect(isResponseCacheOptIn({}, { "x-888-response-cache": "true" })).toBe(true);
    expect(isResponseCacheOptIn({}, { "x-cache-response": "1" })).toBe(true);
    expect(isResponseCacheOptIn({}, { "other-header": "true" })).toBe(false);
  });
});
