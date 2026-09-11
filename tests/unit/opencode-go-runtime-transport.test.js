import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

const GO_KEY = { apiKey: "sk-test-opencode-key" };
const DEEPSEEK = ["deepseek-v4-pro", "deepseek-v4-flash"];

function cred(format) {
  return { ...GO_KEY, runtimeTransport: resolveTransport("opencode-go", format) };
}

describe("OpenCode Go honors chatCore runtimeTransport (#385)", () => {
  const zen = new OpenCodeExecutor();
  const go = new OpenCodeExecutor("opencode-go");

  it("tags the shared executor instance as opencode-go", () => {
    expect(getExecutor("opencode-go").getProvider()).toBe("opencode-go");
    expect(getExecutor("opencode").getProvider()).toBe("opencode");
  });

  it("routes DeepSeek + claude RT to /messages with x-api-key", () => {
    const c = cred("claude");
    for (const m of DEEPSEEK) {
      expect(go.buildUrl(m, true, 0, c)).toBe("https://opencode.ai/zen/go/v1/messages");
      const h = go.buildHeaders(c, true, "", m);
      expect(h["x-api-key"]).toBe("sk-test-opencode-key");
      expect(h.Authorization).toBeUndefined();
      expect(h["anthropic-version"]).toBeDefined();
    }
  });

  it("routes DeepSeek + openai-responses RT to /responses with Bearer key", () => {
    const c = cred("openai-responses");
    for (const m of DEEPSEEK) {
      expect(go.buildUrl(m, true, 0, c)).toBe("https://opencode.ai/zen/go/v1/responses");
      const h = go.buildHeaders(c, true, "", m);
      expect(h.Authorization).toBe("Bearer sk-test-opencode-key");
      expect(h["x-api-key"]).toBeUndefined();
    }
  });

  it("does not let a Go key steal muse-spark off Zen /responses", () => {
    const model = "muse-spark-1.3-contributor-free";
    expect(zen.buildUrl(model, true, 0, GO_KEY)).toBe("https://opencode.ai/zen/v1/responses");
    expect(zen.buildHeaders(GO_KEY, true, "", model).Authorization).toBe("Bearer public");
  });

  it("never treats -free-suffixed opencode-go models as Zen public", () => {
    // The -free suffix is what triggered the original defect (ox-alpha-free
    // rerouted to /zen/v1 with Bearer public before the provider guard).
    // Use a live -free Go id shape (laguna-s-2.1-free: caps entry exists for
    // opencode-go) plus a synthetic future id to cover passthroughModels.
    for (const model of ["laguna-s-2.1-free", "future-go-model-free"]) {
      const c = cred("openai");
      expect(go.buildUrl(model, true, 0, c)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      expect(go.buildHeaders(c, true, "", model).Authorization).toBe("Bearer sk-test-opencode-key");
      // No RT: Go provider still must not drop the key because of the suffix.
      expect(go.buildUrl(model, true, 0, GO_KEY)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      expect(go.buildHeaders(GO_KEY, true, "", model).Authorization).toBe("Bearer sk-test-opencode-key");
    }
  });

  it("floors max_output_tokens on the Go Responses path", () => {
    const c = cred("openai-responses");
    const out = go.transformRequest("deepseek-v4-pro", { input: "hi", max_tokens: 1 }, true, c);
    expect(out.max_output_tokens).toBe(16);
    expect(out.max_tokens).toBeUndefined();
  });
});
