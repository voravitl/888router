import { describe, it, expect } from "vitest";
import { computePrefixHash, getRotatedModels, attachRouterDecisionHeader } from "../../open-sse/services/combo.js";

describe("cache-optimized combo routing", () => {
  it("computes deterministic 32-bit hash for identical prompt prefixes", () => {
    const body1 = {
      messages: [
        { role: "system", content: "You are an expert developer assistant." },
        { role: "user", content: "Write a function to sort an array." }
      ]
    };
    const body2 = {
      messages: [
        { role: "system", content: "You are an expert developer assistant." },
        { role: "user", content: "Write a function to reverse a string." }
      ]
    };

    const hash1 = computePrefixHash(body1);
    const hash2 = computePrefixHash(body2);

    // Identical system instructions yield identical prefix hash (first 2,048 chars)
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("number");
    expect(hash1).toBeGreaterThanOrEqual(0);
  });

  it("pins to the exact same candidate model for identical prefix across calls", () => {
    const models = ["provider-a/model-1", "provider-b/model-2", "provider-c/model-3"];
    const body = {
      messages: [
        { role: "system", content: "You are an expert pair programmer." }
      ],
      tools: [{ type: "function", function: { name: "grep_search" } }]
    };

    const run1 = getRotatedModels(models, "code-combo", "cache-optimized", 1, body);
    const run2 = getRotatedModels(models, "code-combo", "cache-optimized", 1, body);
    const run3 = getRotatedModels(models, "code-combo", "cache-optimized", 1, body);

    expect(run1[0]).toBe(run2[0]);
    expect(run2[0]).toBe(run3[0]);
    expect(models).toContain(run1[0]);
  });

  it("attaches X-Router-Decision telemetry header with strategy and model details", () => {
    const originalRes = new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });

    const res = attachRouterDecisionHeader(originalRes, {
      strategy: "cache-optimized",
      model: "anthropic/claude-3-7-sonnet",
      fallbackCount: 0,
      status: "ok",
      savingsTokens: 1420
    });

    expect(res.headers.get("X-Router-Decision")).toBe(
      "strategy=cache-optimized; model=anthropic/claude-3-7-sonnet; fallback_count=0; status=ok; savings_tokens=1420"
    );
  });
});
