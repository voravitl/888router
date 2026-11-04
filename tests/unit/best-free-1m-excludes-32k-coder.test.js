import { describe, it, expect } from "vitest";
import { resolveKnownContextWindow } from "../../open-sse/providers/capabilities.js";
import { resolveVirtualAutoCombo } from "../../open-sse/services/autoCombo/virtualFactory.js";

const COUNTERFEIT_1M = [
  ["cloudflare-ai", "@cf/qwen/qwen2.5-coder-32b-instruct"],
  ["hyperbolic", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  ["llm7", "qwen2.5-coder-32b-instruct"],
];

describe("Qwen2.5-Coder-32B is a 32k model, not 1M", () => {
  it.each(COUNTERFEIT_1M)("%s/%s resolves to 32768", (provider, model) => {
    expect(resolveKnownContextWindow(provider, model)).toBe(32768);
  });

  it("auto/best-free-1m does not contain them", () => {
    const combo = resolveVirtualAutoCombo("auto/best-free-1m");
    for (const [provider, model] of COUNTERFEIT_1M) {
      expect(combo.models).not.toContain(`${provider}/${model}`);
    }
  });
});
