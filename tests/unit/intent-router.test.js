import { describe, it, expect } from "vitest";
import { classifyRequestIntent, routeByIntent } from "../../open-sse/translator/concerns/intentRouter.js";

describe("P3: Smart Intent-Based Router (Dynamic Same-Family)", () => {
  it("classifies simple queries with fast keywords as 'fast' intent", () => {
    const body = {
      messages: [{ role: "user", content: "what is JavaScript?" }]
    };
    expect(classifyRequestIntent(body)).toBe("fast");
  });

  it("does NOT classify short queries without fast keywords as 'fast' intent", () => {
    const body = {
      messages: [{ role: "user", content: "Implement quicksort in Rust" }]
    };
    expect(classifyRequestIntent(body)).toBe("standard"); // Preserved as standard!
  });

  it("does NOT match 'exceptional' as heavy keyword due to word boundary protection", () => {
    const body = {
      messages: [{ role: "user", content: "Please write an exceptional customer support response." }]
    };
    expect(classifyRequestIntent(body)).not.toBe("heavy");
  });

  it("classifies complex queries with stack traces as 'heavy' intent", () => {
    const body = {
      messages: [{ role: "user", content: "Uncaught TypeError: Cannot read property 'map' of undefined at process (app.js:45)" }]
    };
    expect(classifyRequestIntent(body)).toBe("heavy");
  });

  it("dynamically routes future model versions within the same family", () => {
    const bodyFast = { messages: [{ role: "user", content: "explain what is JSON" }] };
    const bodyHeavy = { messages: [{ role: "user", content: "stacktrace exception at app.js:10" }] };
    const headers = { "x-888-auto-route": "true" };

    // Dynamic Anthropic family mapping (Claude 4 / Claude 4.5)
    expect(routeByIntent(bodyFast, "claude-4-sonnet", headers).model).toBe("claude-4-haiku");
    expect(routeByIntent(bodyHeavy, "claude-4-haiku", headers).model).toBe("claude-4-sonnet");

    // Dynamic OpenAI family mapping (GPT-5)
    expect(routeByIntent(bodyFast, "gpt-5", headers).model).toBe("gpt-5-mini");
    expect(routeByIntent(bodyHeavy, "gpt-5-mini", headers).model).toBe("gpt-5");

    // Dynamic Gemini family mapping (Gemini 3.0)
    expect(routeByIntent(bodyFast, "gemini-3.0-pro", headers).model).toBe("gemini-3.0-flash-lite");
    expect(routeByIntent(bodyHeavy, "gemini-3.0-flash-lite", headers).model).toBe("gemini-3.0-flash");
  });
});
