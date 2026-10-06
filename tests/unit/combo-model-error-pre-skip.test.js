import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks for combo.js dependencies (same pattern as combo-all-failed-retry-after.test.js) ---
vi.mock("open-sse/services/accountFallback.js", () => ({
  checkFallbackError: vi.fn((status, errorText) => {
    const lower = String(errorText || "").toLowerCase();
    // "not supported" → permanent model error (mirrors errorConfig.js rule)
    if (/not supported/.test(lower)) {
      return { shouldFallback: false, cooldownMs: 0, modelError: true };
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
