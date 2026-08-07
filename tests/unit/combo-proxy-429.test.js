import { describe, it, expect, vi } from "vitest";

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

vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("open-sse/translator/formats/gemini.js", () => ({
  extractTextContent: vi.fn(() => ""),
}));

vi.mock("open-sse/config/runtimeConfig.js", () => ({
  HTTP_STATUS: { RATE_LIMITED: 429, SERVICE_UNAVAILABLE: 503, OK: 200 },
}));

// Import AFTER mocks.
const { handleComboChat } = await import("../../open-sse/services/combo.js");

function makeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: JSON.stringify(body),
    headers: { get: (name) => (name === "content-type" ? "application/json" : null) },
    clone: () => ({
      json: async () => body,
    }),
  };
}

describe("combo 429 → proxy pool exhausted (quota-limited)", () => {
  it("when EVERY model is 429 quota-limited, returns 429+retryAfter instead of switching to a shared-quota model", async () => {
    // Two models, both share the same exhausted ollama quota/pool → both 429.
    const models = ["ollama/deepseek-v4-flash", "ollama/glm-5.2"];
    const handleSingleModel = vi.fn(async () =>
      makeResponse(429, { error: { message: "Rate limit exceeded. Please try again later." } })
    );

    const result = await handleComboChat({
      body: { model: "my-combo" },
      models,
      handleSingleModel,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      comboName: "my-combo",
    });

    // The combo should STOP at 429 with a retryAfter, NOT emit a 503 that
    // conflates quota exhaustion with genuine unavailability.
    expect(result.status).toBe(429);
    expect(result.__unavailable).toBe(true);
    expect(result.retryAfter).toBeTruthy();
    // Layer below already rotated proxies per model; combo should not have
    // switched models — both were tried and both quota-limited.
    expect(handleSingleModel).toHaveBeenCalledTimes(models.length);
  });

  it("model without explicit retryAfter derives a cooldown from quota-limited 429", async () => {
    // ollama's FreeUsageLimitError has no retryAfter field — the fix must
    // derive a cooldown so the client still gets a usable retry window.
    const models = ["ollama/deepseek-v4-flash"];
    const handleSingleModel = vi.fn(async () =>
      makeResponse(429, { error: { type: "FreeUsageLimitError", message: "Rate limit exceeded" } })
    );

    const result = await handleComboChat({
      body: { model: "my-combo" },
      models,
      handleSingleModel,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      comboName: "my-combo",
    });

    expect(result.status).toBe(429);
    expect(result.retryAfter).toBeTruthy(); // derived from cooldown
  });

  it("model error (not quota) still falls through to next model", async () => {
    // First model has a permanent model error → combo should skip to model 2.
    const models = ["provider/model-a", "provider/model-b"];
    const handleSingleModel = vi.fn(async (_, m) =>
      m === "provider/model-a"
        ? makeResponse(404, { error: { message: "model not found" } })
        : makeResponse(200, { choices: [{ message: { content: "ok" } }] })
    );

    const result = await handleComboChat({
      body: { model: "my-combo" },
      models,
      handleSingleModel,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      comboName: "my-combo",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2); // model-a error → model-b success
    expect(result.status).toBe(200);
  });
});

describe("combo reasoning empty-content retry", () => {
  it("retries once with a raised max_tokens when a reasoning model returns empty content with finish_reason length", async () => {
    const models = ["openai/deepseek-reasoner"];
    const handleSingleModel = vi.fn(async (body) =>
      body.max_tokens === 200
        // first attempt: burned budget on reasoning, empty content
        ? makeResponse(200, {
            choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "lots of thinking..." } }],
          })
        // retry with raised budget: real answer
        : makeResponse(200, {
            choices: [{ finish_reason: "stop", message: { content: "final answer" } }],
          })
    );

    const result = await handleComboChat({
      body: { model: "my-combo", max_tokens: 200, stream: false },
      models,
      handleSingleModel,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      comboName: "my-combo",
    });

    expect(result.status).toBe(200);
    // first attempt (empty reasoning) + one retry with raised max_tokens
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(handleSingleModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ max_tokens: expect.any(Number) }),
      "openai/deepseek-reasoner"
    );
  });

  it("does not retry when content is present", async () => {
    const handleSingleModel = vi.fn(async () =>
      makeResponse(200, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      })
    );

    const result = await handleComboChat({
      body: { model: "my-combo", max_tokens: 200, stream: false },
      models: ["openai/deepseek-reasoner"],
      handleSingleModel,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      comboName: "my-combo",
    });

    expect(result.status).toBe(200);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});
