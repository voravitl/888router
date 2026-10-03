import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks for combo.js dependencies ---
vi.mock("open-sse/services/accountFallback.js", () => ({
  checkFallbackError: vi.fn((status, errorText, backoffLevel = 0) => {
    const lower = String(errorText || "").toLowerCase();
    // 429 or quota-text → backoff (shouldFallback)
    if (status === 429 || /rate.?limit|quota|usage.?limit|too many requests/.test(lower)) {
      return { shouldFallback: true, cooldownMs: 60_000, newBackoffLevel: 1 };
    }
    // model error → no fallback
    if (/model not found|invalid.*model/.test(lower)) {
      return { shouldFallback: false, cooldownMs: 0, modelError: true };
    }
    // default transient
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
  markComboHeadTimeout,
  clearComboHeadTimeoutCooldown,
} = await import("../../open-sse/services/combo.js");

// A failed candidate response, optionally carrying the Retry-After header that
// unavailableResponse() (open-sse/utils/error.js) emits for "pool parked /
// accounts locked / reset after Ns" verdicts.
function makeFailure(status, message, retryAfterSeconds) {
  return {
    status,
    ok: false,
    statusText: message,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === "content-type") return "application/json";
        if (key === "retry-after" && retryAfterSeconds != null) return String(retryAfterSeconds);
        return null;
      },
    },
    clone: () => ({ json: async () => ({ error: { message } }) }),
  };
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

describe("combo all-failed verdict carries the earliest known recovery time as Retry-After (#517)", () => {
  beforeEach(() => clearComboHeadTimeoutCooldown());
  afterEach(() => clearComboHeadTimeoutCooldown());

  it("every candidate says 'reset after Ns' → Retry-After = the earliest, status unchanged", async () => {
    const waits = { "a/one": 29, "b/two": 11, "a/three": 24 };
    const { result, handleSingleModel } = await runCombo(Object.keys(waits), (m) =>
      makeFailure(502, `[${m}] [502]: Unknown error (reset after ${waits[m]}s)`, waits[m]),
    );

    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(502); // not rewritten to a 429
    expect(result.headers.get("Retry-After")).toBe("11");
  });

  it("one candidate failed without a hint → no Retry-After (an immediate retry might still work)", async () => {
    const { result } = await runCombo(["a/one", "b/two"], (m) =>
      m === "a/one" ? makeFailure(502, "parked", 29) : makeFailure(500, "boom", null),
    );

    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.headers.get("Retry-After")).toBeNull();
  });

  it("caps the hint at 60s (the horizon clients honour) but never goes below 1s", async () => {
    const long = await runCombo(["a/one"], () => makeFailure(503, "suspended", 1800));
    expect(long.result.headers.get("Retry-After")).toBe("60");

    const tiny = await runCombo(["a/one"], () => makeFailure(503, "almost", 0.2));
    expect(tiny.result.headers.get("Retry-After")).toBe("1");
  });

  it("a candidate skipped by the stream-head cooldown contributes its remaining cooldown", async () => {
    markComboHeadTimeout("a/one", 20_000);
    const { result, handleSingleModel } = await runCombo(["a/one", "b/two"], () =>
      makeFailure(502, "parked", 7),
    );

    expect(handleSingleModel).toHaveBeenCalledTimes(1); // a/one never attempted
    expect(result.headers.get("Retry-After")).toBe("7"); // min(20s cooldown, 7s)
  });

  it("every candidate parked by the cooldown → 503 that tells the client when to come back", async () => {
    markComboHeadTimeout("a/one", 20_000);
    markComboHeadTimeout("b/two", 20_000);
    const { result, handleSingleModel } = await runCombo(["a/one", "b/two"], () => {
      throw new Error("must not be called");
    });

    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(result.status).toBe(503);
    const retryAfter = Number(result.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(19);
    expect(retryAfter).toBeLessThanOrEqual(20);
  });
});

// Independent review of #517: the fixtures above are plain objects with no
// body, so the combo's real error-body read (result.body.getReader()) never ran
// in front of the Retry-After capture. These use real Response objects, the way
// unavailableResponse() and the executors hand them over.
function realFailure(status, message, retryAfterSeconds) {
  const headers = { "Content-Type": "application/json" };
  if (retryAfterSeconds != null) headers["Retry-After"] = String(retryAfterSeconds);
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

describe("combo all-failed Retry-After with real Response objects (#517)", () => {
  beforeEach(() => clearComboHeadTimeoutCooldown());
  afterEach(() => clearComboHeadTimeoutCooldown());

  it("reads the error body AND the Retry-After header of each candidate → earliest wins", async () => {
    const waits = { "a/one": 29, "b/two": 9 };
    const { result, handleSingleModel } = await runCombo(Object.keys(waits), (m) =>
      realFailure(502, `[${m}] [502]: Unknown error (reset after ${waits[m]}s)`, waits[m]),
    );

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(502);
    expect(result.headers.get("Retry-After")).toBe("9");
    const body = await result.json();
    expect(body.error.message).toContain("reset after 9s"); // last candidate's message still surfaces
  });

  it("a real failure without Retry-After keeps the verdict header-less", async () => {
    const { result } = await runCombo(["a/one", "b/two"], (m) =>
      m === "a/one" ? realFailure(502, "parked", 20) : realFailure(502, "boom", null),
    );

    expect(result.status).toBe(502);
    expect(result.headers.get("Retry-After")).toBeNull();
  });
});
