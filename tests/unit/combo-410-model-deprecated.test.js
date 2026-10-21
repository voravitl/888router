import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression tests for the 2026-10-21 incident: an upstream HTTP 410
// (ModelDeprecated) for ONE model poisoned the WHOLE shared opencode proxy
// pool set, so every sibling `oc/*` model in the combo then failed with the
// same 410 — and the combo reported the whole thing as
// "All models quota-limited" (429), which is a lie: nothing was quota-limited.
//
// Root cause, reproduced live (see the probes in the PR description):
//   1. opencode.ai answers 410 ModelDeprecated for a retired model id.
//   2. 410 matched NO rule in ERROR_RULES → default transient rule →
//      cooldownMs = TRANSIENT_COOLDOWN_MS (30s) → markAccountUnavailable
//      PARKS the shared proxy pool for 30s.
//   3. The relay is shared by every `oc/*` model, so parking it took down
//      beam-free / glm-5.3-flash-free / longcat / minimax too.
//   4. The combo then saw "410 … (reset after 26s)" on every candidate and
//      took the earliestRetryAfter path → 429 "All models quota-limited".
//
// The fix has three parts, each pinned here:
//   (a) 410 / "ModelDeprecated" is a PERMANENT MODEL error: the model identity
//       is dead upstream. It must skip to the next model and must NOT park a
//       shared pool (the pool is healthy — the MODEL is gone).
//   (b) The combo's 429 "all models quota-limited" verdict must require an
//       ACTUAL quota signal. A Retry-After header alone is not one.
//   (c) A combo whose members all failed with model-identity errors must not
//       be reported as a quota problem.
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleComboChat, clearComboKnownUnavailable } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };

// A failing candidate whose body carries the upstream 410 envelope verbatim.
//
// This MUST be a real Response: combo.js reads the error body through
// `result.body.getReader()` (open-sse/services/combo.js, the error-extraction
// block). A plain object with `body: null` is never read, so the combo would
// see only statusText and the fixture would pass for the wrong reason.
function make410(message) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "ModelDeprecated", message },
      metadata: { model: "muse-spark-1.3-contributor-free" },
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  );
}

describe("410 ModelDeprecated is a permanent MODEL error, not a transient pool failure", () => {
  it("classifies the upstream ModelDeprecated envelope as a permanent model error", () => {
    const r = checkFallbackError(
      410,
      '{"type":"error","error":{"type":"ModelDeprecated","message":"Model muse-spark-1.3-contributor-free has been deprecated."}}',
    );
    expect(r.modelError).toBe(true);
    expect(r.permanentModelError).toBe(true);
    // A dead model identity must not rotate accounts / park a shared pool.
    expect(r.shouldFallback).toBe(false);
    expect(r.cooldownMs).toBe(0);
  });

  it("classifies a bare 410 status as a permanent model error", () => {
    const r = checkFallbackError(410, "Gone");
    expect(r.modelError).toBe(true);
    expect(r.permanentModelError).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("does NOT park the shared proxy pool for a 410 (the pool is healthy, the model is gone)", () => {
    // The regression: 410 fell through to the default transient rule, which
    // returned shouldFallback=true → markAccountUnavailable parked the shared
    // relay → every sibling oc/* model in the combo died with the same 410.
    const r = checkFallbackError(410, "Model X has been deprecated.");
    expect(r.shouldFallback).toBe(false);
    expect(r.parkMs).toBeUndefined();
  });

  it("keeps a 402 (payment required) parking the pool — that one IS the pool's fault", () => {
    // Guard against over-broadening: 402 is a relay-account problem, so it
    // must still rotate and park.
    const r = checkFallbackError(402, "Payment required\n\nDEPLOYMENT_DISABLED");
    expect(r.shouldFallback).toBe(true);
    expect(r.modelError).toBeFalsy();
  });
});

describe("combo verdict honesty: 410-only failures are not a quota problem", () => {
  beforeEach(() => {
    clearComboKnownUnavailable();
  });

  it("does not report 410-only failures as 429 'All models quota-limited'", async () => {
    const models = ["oc/beam-free", "oc/glm-5.3-flash-free"];
    const handleSingleModel = vi.fn(async () =>
      make410('Model muse-spark-1.3-contributor-free has been deprecated.'),
    );

    const result = await handleComboChat({
      body: { model: "9-free" },
      models,
      handleSingleModel,
      log,
      comboName: "9-free",
      comboStrategy: "fallback",
    });

    // The verdict must carry the real status, not a fabricated 429.
    expect(result.status).toBe(410);
    const body = await result.json();
    expect(JSON.stringify(body)).not.toMatch(/quota-limited/i);
  });

  it("still reports 429 when a candidate really was quota-limited", async () => {
    // The counterpart guard: the quota verdict must not be broken by the fix.
    const models = ["a/quota", "b/quota"];
    const handleSingleModel = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleComboChat({
      body: { model: "quota-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "quota-combo",
      comboStrategy: "fallback",
    });

    expect(result.status).toBe(429);
  });

  it("does not call a non-quota failure 'quota-limited' just because it carried a retryAfter", async () => {
    // The second half of the bug: a body-level `retryAfter` on a NON-quota
    // failure used to set the combo's earliest-retry clock, and the verdict
    // then said "All models quota-limited" (429) for a failure set where
    // nothing was quota-limited. The client is told to back off for a quota
    // that does not exist, and the real cause (a dead model / a 500) is
    // hidden behind a fabricated 429.
    //
    // The `retryAfter` must be a TOP-LEVEL field of the error body — that is
    // the shape combo.js reads (`errorBody?.retryAfter`).
    const models = ["a/one", "b/two"];
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    const handleSingleModel = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "Internal server error" }, retryAfter: retryAt }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await handleComboChat({
      body: { model: "nonquota-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "nonquota-combo",
      comboStrategy: "fallback",
    });

    // A 500 with a stray retryAfter is not a quota problem: the verdict must
    // keep the real status, not claim 429.
    expect(result.status).toBe(500);
  });
});
