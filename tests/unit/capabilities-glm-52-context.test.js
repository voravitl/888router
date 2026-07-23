import { describe, expect, it } from "vitest";

import { resolveKnownContextWindow } from "../../open-sse/providers/capabilities.js";

// GLM-5.2 ships a 1M-token context window (z.ai default, no LongCast flag).
// BytePlus/bpm exposes it under a dash/date-suffixed id ("glm-5-2-260617")
// that the exact MODEL_CAPABILITIES key ("glm-5.2", dot form) does not catch.
// The *glm-5.2* / *glm-5-2* glob patterns must resolve both forms to 1M
// before the generic *glm-5* (200k) fallback fires.
describe("GLM-5.2 1M context capabilities", () => {
  const cases = [
    ["bpm", "glm-5-2-260617"], // BytePlus dash/date form (the bug)
    ["glm", "glm-5.2"], // z.ai dot form
    ["volcengine", "glm-5.2"],
    ["ollama", "glm-5.2"],
    ["openrouter", "glm-5.2"],
  ];

  for (const [provider, model] of cases) {
    it(`resolves ${provider}/${model} to a 1M context window`, () => {
      expect(resolveKnownContextWindow(provider, model)).toBe(1000000);
    });
  }

  it("keeps GLM-5.1 / GLM-5 / GLM-4.7 at the standard 200k context", () => {
    expect(resolveKnownContextWindow("glm", "glm-5.1")).toBe(200000);
    expect(resolveKnownContextWindow("glm", "glm-5")).toBe(200000);
    expect(resolveKnownContextWindow("glm", "glm-4.7")).toBe(200000);
  });

  it("does not falsely bump a dash/date GLM-5.1 variant to 1M", () => {
    expect(resolveKnownContextWindow("bpm", "glm-5-1-010125")).toBe(200000);
  });
});
