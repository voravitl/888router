import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// models.dev `alibaba-token-plan` publishes 1,000,000 for every qwen3.8 model it
// lists (qwen3.8-flash, qwen3.8-max, qwen3.8-max-preview). Without an explicit
// *qwen3.8* pattern, flash fell through to the generic *qwen* glob's 262,144 and
// the gateway advertised a quarter of the real window — the "context ไม่ตรง"
// report. This pins the family so a future glob reorder cannot silently drop it.
const TOKEN_PLAN_1M = [
  "qwen3.8-max-preview",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "glm-5.2",
  "glm-5.3",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

describe("alitp-intl context windows match models.dev", () => {
  it.each(TOKEN_PLAN_1M)("%s is 1,000,000", (model) => {
    expect(getCapabilitiesForModel("alitp-intl", model).contextWindow).toBe(1000000);
  });

  it("keeps the same answer for the sibling Alibaba providers", () => {
    for (const provider of ["alims-intl", "alicode-intl"]) {
      expect(getCapabilitiesForModel(provider, "qwen3.8-flash").contextWindow).toBe(1000000);
    }
  });

  it("does not lift qwen3.8-flash-next, which is genuinely 262,144", () => {
    // A different SKU, not a suffix of qwen3.8-flash — the pattern must not catch it
    // by accident and inflate its window.
    const caps = getCapabilitiesForModel("openrouter", "qwen3.8-flash-next");
    expect(caps.contextWindow).toBeLessThanOrEqual(262144);
  });
});