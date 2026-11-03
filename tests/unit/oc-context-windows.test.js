import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";

// Every id in the `oc` (OpenCode Zen free) registry previously fell through to
// DEFAULT_CAPABILITIES' 200,000/64,000 floor. Verified against models.dev
// `opencode`: 8 of 9 were wrong — four overstated by 5x (the gateway accepts a
// request the upstream then rejects) and one understated by 8x. These pin the
// values so a future glob change cannot silently drop them back to the floor.
// `vision` is pinned too: writing the DEFAULT false into a catalogue entry is a
// silent regression, because these ids previously inherited vision:true from
// PATTERN_CAPABILITIES and would start stripping image blocks the model accepts.
// Values mirror models.dev `opencode` input modalities.
const EXPECTED = {
  "nemotron-3-ultra-free":      { contextWindow: 1000000, maxOutput: 128000, vision: false },
  "nemotron-3.5-lightning-free":{ contextWindow: 262144,  maxOutput: 262144, vision: false },
  "nemotron-3.5-super-vl-free": { contextWindow: 1048576, maxOutput: 131072, vision: true },
  "mimo-v2.6-flash-free":       { contextWindow: 200000,  maxOutput: 32000,  vision: true },
  "beam-free":                  { contextWindow: 1048576, maxOutput: 131072, vision: false },
  "deepseek-v4.1-flash-free":   { contextWindow: 200000,  maxOutput: 32000,  vision: false },
  "glm-5.3-flash-free":         { contextWindow: 200000,  maxOutput: 32000,  vision: true },
  "longcat-2.5-preview-free":   { contextWindow: 1000000, maxOutput: 131072, vision: true },
  "big-pickle":                 { contextWindow: 200000,  maxOutput: 64000,  vision: false },
};

describe("oc (OpenCode Zen free) context windows match models.dev", () => {
  it("covers every registered oc model", () => {
    const registered = PROVIDER_MODELS.oc.map((m) => m.id).sort();
    expect(registered).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s", (model, want) => {
    const caps = getCapabilitiesForModel("oc", model);
    expect({
      contextWindow: caps.contextWindow,
      maxOutput: caps.maxOutput,
      vision: caps.vision === true,
    }).toEqual(want);
  });

  it("does not leave any registered id on the 200k floor by accident", () => {
    // 200,000 is legitimate for several ids, but it must be an explicit entry,
    // not the DEFAULT_CAPABILITIES fallback. A model with no entry also gets
    // vision:false, maxOutput:64000 — assert the entry exists instead.
    for (const model of Object.keys(EXPECTED)) {
      const caps = getCapabilitiesForModel("oc", model);
      expect(caps.reasoning).toBe(true);
    }
  });

  it("does not redefine nara, which registers the same model id", () => {
    // models.dev has no nara provider, so the catalogue entry measured on
    // OpenCode Zen's upstream must not silently shrink nara's limits.
    const nara = getCapabilitiesForModel("nara", "deepseek-v4.1-flash-free");
    expect(nara.contextWindow).toBe(1000000);
    expect(nara.maxOutput).toBe(384000);
  });

  it("keeps the OC Alpha entry at 1M even though it is not in the registry", () => {
    // x-preview-f-free is served through `oc` but listed only via the OC Alpha
    // capability constant, so guard it separately rather than via PROVIDER_MODELS.
    expect(getCapabilitiesForModel("oc", "x-preview-f-free").contextWindow).toBe(1000000);
  });
});