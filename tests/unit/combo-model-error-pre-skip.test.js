import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks for combo.js dependencies (same pattern as combo-all-failed-retry-after.test.js) ---
// Mirrors the real errorConfig.js split: permanent identity errors park the
// hop; request-scoped errors (context length, 413) must NEVER park it.
vi.mock("open-sse/services/accountFallback.js", () => ({
  checkFallbackError: vi.fn((status, errorText) => {
    const lower = String(errorText || "").toLowerCase();
    // "not supported" → permanent identity error (mirrors errorConfig.js rule)
    if (/not supported/.test(lower)) {
      return { shouldFallback: false, cooldownMs: 0, modelError: true, permanentModelError: true };
    }
    // context-length / 413 → request-scoped model error, must not park
    if (/context_length_exceeded|prompt is too long/.test(lower) || status === 413) {
      return { shouldFallback: false, cooldownMs: 0, modelError: true, permanentModelError: false };
    }
    if (status === 429 || /quota|rate.?limit/.test(lower)) {
      return { shouldFallback: true, cooldownMs: 60_000, newBackoffLevel: 1 };
    }
    return { shouldFallback: true, cooldownMs: 1000 };
  }),
  formatRetryAfter: vi.fn((iso) => `~${Math.round((new Date(iso).getTime() - Date.now()) / 1000)}s`),
  getUnavailableUntil: vi.fn((cooldownMs) => new Date(Date.now() + cooldownMs).toISOString()),
}));

vi.mock("open-sse/utils/error.js", () => ({
  unavailableResponse: vi.fn((status, message, retryAfter, retryHuman) => ({
    status,
    statusText: message,
    retryAfter,
    retryAfterHuman: retryHuman,
    __unavailable: true,
  })),
}));

vi.mock("open-sse/providers/capabilities.js", async (importOriginal) => ({
  ...await importOriginal(),
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("open-sse/translator/formats/gemini.js", () => ({
  extractTextContent: vi.fn(() => ""),
}));

vi.mock("open-sse/config/runtimeConfig.js", async (importOriginal) => ({
  ...await importOriginal(),
  HTTP_STATUS: { RATE_LIMITED: 429, SERVICE_UNAVAILABLE: 503, OK: 200 },
}));

// Import AFTER mocks.
const {
  handleComboChat,
  getComboKnownUnavailable,
  clearComboKnownUnavailable,
  getComboHeadTimeoutCooldown,
  clearComboHeadTimeoutCooldown,
  resolveModelErrorCooldownMs,
} = await import("../../open-sse/services/combo.js");

const enc = new TextEncoder();

// A failed candidate response carrying an error message the classifier sees.
function makeFailure(status, message) {
  return {
    status,
    ok: false,
    statusText: message,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "content-type") return "application/json";
        return null;
      },
    },
    clone: () => ({ json: async () => ({ error: { message } }) }),
  };
}

// A streaming 2xx whose head carries the given SSE frames, then ends.
function makeSseResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null),
    },
    body: stream,
  };
}

function makeSseSuccess() {
  return makeSseResponse([
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
    "data: [DONE]\n\n",
  ]);
}

const log = { info: () => {}, warn: () => {}, error: () => {} };

async function runCombo(models, responseFor) {
  const handleSingleModel = vi.fn(async (_body, modelStr) => responseFor(modelStr));
  const result = await handleComboChat({
    body: { model: "my-combo" },
    models,
    handleSingleModel,
    log,
    comboName: "my-combo",
  });
  return { result, handleSingleModel };
}

describe("combo parks permanent model-error hops so the next request pre-skips them", () => {
  beforeEach(() => { clearComboHeadTimeoutCooldown(); clearComboKnownUnavailable(); });
  afterEach(() => { clearComboHeadTimeoutCooldown(); clearComboKnownUnavailable(); });

  it("first request walks the dead hop and fails over; the hop is parked with a ~1h TTL", async () => {
    const { result, handleSingleModel } = await runCombo(
      ["cx/gpt-6-sol", "ocg/muse-spark"],
      (m) => (m === "cx/gpt-6-sol"
        ? makeFailure(400, "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.")
        : makeSseSuccess()),
    );

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);

    const parkedUntil = getComboKnownUnavailable("cx/gpt-6-sol");
    expect(parkedUntil).toBeGreaterThan(Date.now());
    const ttlMinutes = (parkedUntil - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(55);
    expect(ttlMinutes).toBeLessThanOrEqual(61);
  });

  it("second request pre-skips the parked hop instead of re-paying the 400", async () => {
    const responseFor = (m) => (m === "cx/gpt-6-sol"
      ? makeFailure(400, "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.")
      : makeSseSuccess());
    await runCombo(["cx/gpt-6-sol", "ocg/muse-spark"], responseFor);

    const { handleSingleModel } = await runCombo(["cx/gpt-6-sol", "ocg/muse-spark"], responseFor);

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ocg/muse-spark");
  });

  it("request-scoped model errors (context length, 413) fail over but do NOT park the hop", async () => {
    // A long prompt trips context_length_exceeded on the first candidate…
    const longPromptFor = (m) => (m === "ag/gemini"
      ? makeFailure(400, "This model's maximum context length is 128000 tokens, however you requested 200000 tokens.")
      : makeSseSuccess());
    const first = await runCombo(["ag/gemini", "ocg/muse-spark"], longPromptFor);
    expect(first.handleSingleModel).toHaveBeenCalledTimes(2);
    expect(first.result.status).toBe(200);
    expect(getComboKnownUnavailable("ag/gemini")).toBe(0);

    // …and a later short prompt must still reach the (healthy) model.
    const shortPromptFor = () => makeSseSuccess();
    const { handleSingleModel } = await runCombo(["ag/gemini", "ocg/muse-spark"], shortPromptFor);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ag/gemini");
  });

  it("HTTP 413 fails over but does NOT park the hop", async () => {
    const responseFor = (m) => (m === "ag/gemini"
      ? { ...makeFailure(413, "payload too large"), status: 413 }
      : makeSseSuccess());
    const first = await runCombo(["ag/gemini", "ocg/muse-spark"], responseFor);
    expect(first.handleSingleModel).toHaveBeenCalledTimes(2);
    expect(getComboKnownUnavailable("ag/gemini")).toBe(0);

    const { handleSingleModel } = await runCombo(["ag/gemini", "ocg/muse-spark"], () => makeSseSuccess());
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ag/gemini");
  });
});

describe("resolveModelErrorCooldownMs", () => {
  it("defaults to 1h; clamps to the 1m–6h range; reads env per call", () => {
    expect(resolveModelErrorCooldownMs({})).toBe(3_600_000);
    expect(resolveModelErrorCooldownMs({ COMBO_MODEL_ERROR_COOLDOWN_MS: "bogus" })).toBe(3_600_000);
    expect(resolveModelErrorCooldownMs({ COMBO_MODEL_ERROR_COOLDOWN_MS: "1" })).toBe(60_000);
    expect(resolveModelErrorCooldownMs({ COMBO_MODEL_ERROR_COOLDOWN_MS: "60000" })).toBe(60_000);
    expect(resolveModelErrorCooldownMs({ COMBO_MODEL_ERROR_COOLDOWN_MS: "3600000" })).toBe(3_600_000);
    expect(resolveModelErrorCooldownMs({ COMBO_MODEL_ERROR_COOLDOWN_MS: "999999999" })).toBe(21_600_000);
  });
});

describe("combo parks empty-stream hops so the next request pre-skips them", () => {
  beforeEach(() => { clearComboHeadTimeoutCooldown(); clearComboKnownUnavailable(); });
  afterEach(() => { clearComboHeadTimeoutCooldown(); clearComboKnownUnavailable(); });

  it("a 2xx SSE stream with zero content falls through AND parks the hop", async () => {
    const responseFor = (m) => (m === "ag/gemini"
      ? makeSseResponse(['data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n'])
      : makeSseSuccess());
    const { result, handleSingleModel } = await runCombo(["ag/gemini", "ocg/muse-spark"], responseFor);

    // Same request still fails over to the healthy candidate.
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);

    // …and the empty hop is parked for subsequent requests (same 30s cooldown
    // a stream-head timeout earns — it also wasted the full head-wait).
    const parkedUntil = getComboHeadTimeoutCooldown("ag/gemini");
    expect(parkedUntil).toBeGreaterThan(Date.now());
  });

  it("second request pre-skips the parked empty hop", async () => {
    const responseFor = (m) => (m === "ag/gemini"
      ? makeSseResponse(['data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n'])
      : makeSseSuccess());
    await runCombo(["ag/gemini", "ocg/muse-spark"], responseFor);

    const { handleSingleModel } = await runCombo(["ag/gemini", "ocg/muse-spark"], responseFor);

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("ocg/muse-spark");
  });
});
