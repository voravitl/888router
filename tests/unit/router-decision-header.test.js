import { describe, it, expect } from "vitest";
import { attachRouterDecisionHeader } from "../../open-sse/services/combo.js";

// When a request lands somewhere unexpected — a combo falling through six
// candidates, or a direct call silently served by another account — the only
// place that answer can live without touching the response body is a header.
// These pin the fields a caller actually needs to diagnose that.
function header(meta) {
  const res = attachRouterDecisionHeader(new Response("ok", { status: 200 }), meta);
  return res.headers.get("X-Router-Decision");
}

describe("X-Router-Decision routing header", () => {
  it("names the provider, not just the model", () => {
    // "model=9-sonnet" does not say the traffic went to ollama.
    expect(header({ strategy: "round-robin", model: "ollama/deepseek-v4.1-flash", provider: "ollama" }))
      .toContain("provider=ollama");
  });

  it("lists the candidates that were already tried", () => {
    expect(header({
      strategy: "fallback",
      model: "ollama/x",
      provider: "ollama",
      fallbackCount: 2,
      triedModels: ["kr/claude-opus-5.5", "ag/claude-opus-5-5-high"],
    })).toContain("tried=kr/claude-opus-5.5,ag/claude-opus-5-5-high");
  });

  it("omits provider and tried when there is nothing to report", () => {
    const value = header({ strategy: "fallback", model: "a/b" });
    expect(value).toBe("strategy=fallback; model=a/b; fallback_count=0; status=ok");
    expect(value).not.toContain("provider=");
    expect(value).not.toContain("tried=");
  });

  it("keeps the older fields for a combo fallback", () => {
    const value = header({
      strategy: "round-robin", model: "ollama/x", provider: "ollama",
      fallbackCount: 5, status: "ok", savingsTokens: 420,
    });
    expect(value).toContain("strategy=round-robin");
    expect(value).toContain("fallback_count=5");
    expect(value).toContain("savings_tokens=420");
  });

  it("passes the response through untouched when it has no headers", () => {
    expect(attachRouterDecisionHeader(null, {})).toBeNull();
  });

  it("uses a safe fallback status for a failed response", () => {
    const res = attachRouterDecisionHeader(new Response("bad", { status: 500 }), {});
    expect(res.headers.get("X-Router-Decision")).toContain("status=error");
  });
});
