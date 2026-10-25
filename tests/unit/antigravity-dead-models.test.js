import { describe, it, expect } from "vitest";

// Antigravity retires models WITHOUT removing them from its own live model
// list, so the gateway kept advertising models that cannot answer. Verified
// live 2026-10-22 (every response read in full, with retries on the capacity
// blips that Antigravity returns while its pool is busy):
//
//   ag/gemini-3.6-flash-{high,medium,low,tiered} → 404 "Requested entity was
//                                                     not found"
//   ag/gemini-3.7-flash-{high,medium,low,tiered} → 404 (same)
//   ag/gemini-3.1-pro-{high,low}                → 404 (same)
//   ag/gemini-3.5-flash-{low,extra-low}         → 404 (same)
//   ag/gemini-3-flash-agent                      → 404 (same)
//   ag/gemini-pro-agent                          → 404 (same)
//
// while these still answer:
//   ag/gemini-3.8-flash-{high,medium,low,tiered}, ag/gemini-3-flash,
//   ag/gemini-3.1-flash-lite, ag/gemini-3.1-flash-image, ag/gemini-3.5-flash-lite,
//   ag/gemini-2.5-flash, ag/gemini-2.5-flash-lite, ag/gemini-2.5-flash-thinking
//
// A retired model in the registry is a client walking into a 404: the
// dashboard offers it, /v1/models advertises it, and the request fails.
import REGISTRY from "../../open-sse/providers/registry/index.js";

// The ids Antigravity retired. Keep this list in sync with the evidence above
// and with the disabled-models entries for the ids that come from Google's
// own live list (the "-tiered" bases, which the catalogue expands into
// -high/-medium/-low and which therefore reappear even after the registry
// entries are gone).
export const RETIRED_ANTIGRAVITY_MODELS = [
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.5-flash-extra-low",
  "gemini-3.5-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.6-flash-tiered",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.7-flash-tiered",
  "gemini-3-flash-agent",
  "gemini-pro-agent",
  // Added 2026-10-25 — not retired, NEVER ROLLED OUT. The entry was ported
  // from upstream 9router on 2026-10-17 while Google's fetchAvailableModels
  // did not list Argon yet, and it still does not: the live list for the
  // gateway's account (verified 2026-10-25, token valid, 200 OK) carries 26
  // model keys and none of them is argon or any gemini-4 id — while every
  // other antigravity model answered 12/12 the same day. The gateway's own
  // history agrees: gemini-4-argon-high is 0/5 successful since it was
  // added, all five attempts being 404 "Requested entity was not found".
  // Antigravity answers a model it has not rolled out with the same 404
  // body it uses for retired models, and advertising it sent clients
  // (and the combo picker) into that 404. When Google's rollout lands,
  // the id returns through the dynamic model sync (fetchAvailableModels →
  // parseGeminiCliModels) — and the quota parser already accepts the bare
  // argon key (open-sse/services/usage/google.js).
  "gemini-4-argon-high",
];

describe("antigravity registry", () => {
  const antigravity = REGISTRY.find((p) => p.id === "antigravity");
  const registryIds = new Set((antigravity?.models || []).map((m) => m.id));

  it("does not carry a retired model", () => {
    for (const id of RETIRED_ANTIGRAVITY_MODELS) {
      expect(registryIds.has(id), `${id} is retired (404) but still in the registry`).toBe(false);
    }
  });

  it("still carries the models that answer", () => {
    for (const id of [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "gemini-3-flash",
      "gemini-3.1-flash-image",
    ]) {
      expect(registryIds.has(id), id).toBe(true);
    }
  });

  it("does not carry gemini-4-argon-high (never rolled out, 404s on every call)", () => {
    // Supersedes the old "keeps gemini-4-argon-high registered" decision
    // (2026-10-17): eight days later Argon is still absent from Google's
    // live fetchAvailableModels, and the advertised entry 404s on every
    // call. See the evidence note on RETIRED_ANTIGRAVITY_MODELS above.
    expect(registryIds.has("gemini-4-argon-high")).toBe(false);
  });
});
