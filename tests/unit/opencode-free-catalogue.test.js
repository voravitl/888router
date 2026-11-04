import { describe, it, expect } from "vitest";

// Regression guard for the 2026-10-21 model-catalog cleanup.
//
// opencode.ai retires free model ids over time. A retired id answers HTTP 410
// `ModelDeprecated`; an id that cannot serve the endpoint answers HTTP 400
// `ModelProtocolUnsupported` / "Model is unavailable". Either way the model is
// UNUSABLE, and while the static registry still listed it, `/v1/models`
// advertised it to every client (Hermes included) — which then picked a dead
// model and failed.
//
// The catalogue must list only models that actually serve. Verified live on
// 2026-10-21 against the running gateway (two probes each, identical
// results):
//
//   ALIVE  (200)      nemotron-3-ultra-free      ← NOT in the upstream list,
//                                                   but still serves. "Absent
//                                                   from the upstream list" is
//                                                   NOT evidence of death.
//   ALIVE  (200)      nemotron-3.5-lightning-free, mimo-v2.6-flash-free,
//                     big-pickle, beam-free, deepseek-v4.1-flash-free,
//                     glm-5.3-flash-free, longcat-2.5-preview-free,
//                     minimax-m3.1-flash-free, nemotron-3.5-super-vl-free
//   DEAD   (410)      mimo-v2.5-free, muse-spark-1.2-contributor-free,
//                     muse-spark-1.3-contributor-free, space-bunny-free
//   DEAD   (400)      deepseek-v4-flash-free, ling-3.0-flash-fin-free,
//                     jev-1.13-free
//
// The dead ids are pinned here so a future upstream retirement cannot put
// them back into the advertised catalogue unnoticed.
import opencodeRegistry from "../../open-sse/providers/registry/opencode.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";

const registryIds = opencodeRegistry.models.map((m) => m.id);

// Verified unusable against the live gateway on 2026-10-21 (see header).
const DEAD = [
  "mimo-v2.5-free",                    // 410 ModelDeprecated
  "muse-spark-1.2-contributor-free",   // 410 ModelDeprecated
  "muse-spark-1.3-contributor-free",   // 410 ModelDeprecated
  "space-bunny-free",                  // 410 ModelDeprecated
  "deepseek-v4-flash-free",            // 400 Model is unavailable
  "ling-3.0-flash-fin-free",           // 400 Model is unavailable
  "jev-1.13-free",                     // 400 ModelProtocolUnsupported
  // Retired 2026-10-25: 410 ModelDeprecated, "Use deepseek-v4.1-flash-free
  // instead". It kept being advertised for two more days, and the 9-free
  // combo kept carrying it as a member.
  "minimax-m3.1-flash-free",           // 410 ModelDeprecated
  // Retired by 2026-11-04: both return HTTP 400 on /zen/v1/chat/completions
  // (verified live against opencode.ai/zen/v1).
  "nemotron-3-ultra-free",             // 400 Bad Request
  "longcat-2.5-preview-free",          // 400 Bad Request
];

// Verified serving on 2026-11-04 against live /zen/v1/models + /zen/v1/chat/completions.
const ALIVE = [
  "nemotron-3.5-lightning-free",       // 200
  "mimo-v2.6-flash-free",              // 200
  "big-pickle",                        // 200
  "beam-free",                         // 200
  "deepseek-v4.1-flash-free",          // 200
  "glm-5.3-flash-free",                // 200
  "nemotron-3.5-super-vl-free",        // 200
  "pulse-alpha-free",                  // 200
  "flint-40b-free",                    // 200
  "crouton-alpha-free",                // 200
];

describe("opencode free catalogue lists only models that serve", () => {
  for (const id of DEAD) {
    it(`does NOT advertise the unusable "${id}"`, () => {
      expect(registryIds).not.toContain(id);
    });
  }

  for (const id of ALIVE) {
    it(`advertises the serving "${id}"`, () => {
      expect(registryIds).toContain(id);
    });
  }

  it("advertises no id that is on the dead list (guard against a re-add)", () => {
    const deadStillPresent = registryIds.filter((id) => DEAD.includes(id));
    expect(deadStillPresent).toEqual([]);
  });

  it("exposes the same catalogue through PROVIDER_MODELS (the /v1/models source)", () => {
    // /v1/models builds its opencode list from PROVIDER_MODELS["oc"], which is
    // derived from this registry. If the two ever drift, the dead model comes
    // back — so pin the equality, not just the registry.
    const fromProviderModels = (PROVIDER_MODELS["oc"] || []).map((m) => m.id);
    expect(new Set(fromProviderModels)).toEqual(new Set(registryIds));
  });

  it("keeps the dead ids out of the opencode-go catalogue (a different upstream)", () => {
    // opencode-go is the PAID tier. Its catalogue legitimately lists
    // muse-spark-*-contributor (verified still serving there). Pruning the free
    // tier must not touch the paid one. space-bunny-free was still serving on
    // the paid tier on 2026-10-21 but has since been retired from the live Go
    // catalogue (2026-11-04), so it must NOT be advertised here either.
    const goIds = (PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id);
    expect(goIds).not.toContain("space-bunny-free");
    expect(goIds).toContain("muse-spark-1.3-contributor");
  });
});
