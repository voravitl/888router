import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";

// Backport acceptance for decolua/9router f172c3c4; no live credentials.
describe("Antigravity upstream Hub transport backport", () => {
  it("uses the upstream Hub identity on generation headers", () => {
    const headers = new AntigravityExecutor().buildHeaders({ accessToken: "fixture-token" });
    expect(headers["User-Agent"]).toBe("antigravity/hub/2.24.0 darwin/arm64");
  });
  it.each(["high", "medium", "low"])("preserves the %s tier and thinking level over native HTTP", level => {
    const id = `gemini-4-argon-${level}`;
    const upstream = getModelUpstreamId("ag", id);
    expect(upstream).toBe(`${id}(${level})`);
    const request = { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: {} };
    const body = { model: stripThinkingSuffix(upstream), request };
    applyThinking("antigravity", upstream, body, "antigravity");
    const result = new AntigravityExecutor().transformRequest(id, body, true, { projectId: "fixture" });
    expect(result.model).toBe(id);
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe(level);
    expect(new AntigravityExecutor().buildUrl(id, true)).toContain("/v1internal:streamGenerateContent?alt=sse");
  });
});
