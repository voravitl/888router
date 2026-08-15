import { describe, expect, it } from "vitest";
import {
  getCapabilitiesForModel,
  PROVIDER_CAPABILITIES,
  PATTERN_CAPABILITIES,
} from "../../open-sse/providers/capabilities.js";

/**
 * DeepSeek V4 (pro/flash) is text-only on every provider that publishes it —
 * models.dev reports modalities.input = ["text"] for nvidia, hpc-ai, cortecs,
 * orcarouter, nano-gpt and cloudflare-workers-ai.
 *
 * codebuddy-cn used to declare `vision: true`, which stopped the request
 * translator from stripping image_url blocks, so image-bearing requests hit
 * upstream and were rejected with 400 "unknown variant image_url, expected
 * text". These tests pin the resolved capability AND guard the whole family so
 * the flag cannot be reintroduced for a future deepseek-v4-* model.
 */
describe("DeepSeek V4 is text-only", () => {
  it("resolves vision=false on codebuddy-cn (the provider that regressed)", () => {
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-pro").vision).toBe(false);
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-flash").vision).toBe(false);
  });

  it("resolves falsy vision on every provider that exposes a deepseek-v4 model", () => {
    for (const [provider, models] of Object.entries(PROVIDER_CAPABILITIES)) {
      for (const model of Object.keys(models)) {
        if (!model.includes("deepseek-v4")) continue;
        const caps = getCapabilitiesForModel(provider, model);
        expect(caps.vision, `${provider}/${model} must not advertise vision`).toBeFalsy();
      }
    }
  });

  it("keeps reasoning + context intact (the fix must not strip other caps)", () => {
    const pro = getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-pro");
    expect(pro.reasoning).toBe(true);
    expect(pro.thinkingFormat).toBe("openai");
    expect(pro.thinkingCanDisable).toBe(false);
    expect(pro.contextWindow).toBe(1000000);
    expect(pro.maxOutput).toBe(50000);
  });

  it("INVARIANT: no provider override may grant vision to a deepseek-v4 model", () => {
    const offenders = [];
    for (const [provider, models] of Object.entries(PROVIDER_CAPABILITIES)) {
      for (const [model, caps] of Object.entries(models)) {
        if (model.includes("deepseek-v4") && caps?.vision === true) {
          offenders.push(`${provider}/${model}`);
        }
      }
    }
    expect(offenders, "DeepSeek V4 accepts text only — remove vision:true").toEqual([]);
  });

  it("INVARIANT: the *deepseek-v4* pattern entry stays text-only", () => {
    const entry = PATTERN_CAPABILITIES.find((p) => p.pattern === "*deepseek-v4*");
    expect(entry, "the *deepseek-v4* pattern entry should exist").toBeTruthy();
    expect(entry.caps.vision).toBeFalsy();
  });

  it("falls back to the text-only pattern for an unlisted deepseek-v4 model", () => {
    // A provider/model combination with no explicit override must still resolve
    // text-only via PATTERN_CAPABILITIES, so new V4 variants are safe by default.
    expect(getCapabilitiesForModel("some-new-provider", "deepseek-v4-turbo").vision).toBeFalsy();
  });
});
