import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel, resolveKnownContextWindow } from "../../open-sse/providers/capabilities.js";

// 9router's own Claude-backed aliases (9-opus / 9-sonnet / 9-haiku) carry no
// "claude" substring, so every PATTERN_CAPABILITIES entry misses them. Without
// exact MODEL_CAPABILITIES entries, /v1/models advertises no limits and clients
// fall through to their own fallback default (Hermes showed 256k) — issue #275.
describe("9router alias context capabilities (#275)", () => {
  const oneMillion = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  for (const model of ["9-opus", "9-sonnet"]) {
    it(`resolves ${model} to a 1M context window`, () => {
      expect(getCapabilitiesForModel(null, model)).toMatchObject(oneMillion);
    });

    it(`advertises ${model} limits via resolveKnownContextWindow`, () => {
      expect(resolveKnownContextWindow(null, model)).toBe(1000000);
    });
  }

  it("resolves 9-haiku to the standard 200k context with budget thinking", () => {
    expect(getCapabilitiesForModel(null, "9-haiku")).toMatchObject({
      contextWindow: 200000,
      thinkingFormat: "claude-budget",
      reasoning: true,
      vision: true,
      search: true,
    });
  });

  it("advertises 9-haiku limits via resolveKnownContextWindow", () => {
    expect(resolveKnownContextWindow(null, "9-haiku")).toBe(200000);
  });

  it("resolves 9-free to a 1M context window", () => {
    expect(getCapabilitiesForModel(null, "9-free")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
      thinkingFormat: "openai",
      reasoning: true,
      vision: true,
      search: true,
    });
  });

  it("advertises 9-free limits via resolveKnownContextWindow", () => {
    expect(resolveKnownContextWindow(null, "9-free")).toBe(1000000);
  });

  // Guard against the tempting-but-wrong fix: a broad `*-opus*` / `*-sonnet*`
  // pattern would also swallow the older 200k Claude ids.
  it("leaves older Claude ids on their existing 200k caps", () => {
    for (const model of ["claude-3-opus-20240229", "claude-opus-4.1", "claude-opus-4-5-20251101"]) {
      expect(getCapabilitiesForModel("cc", model).contextWindow).toBe(200000);
    }
  });
});
