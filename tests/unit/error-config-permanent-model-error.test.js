import { describe, it, expect } from "vitest";

// Pinned against the REAL classifier (no mocks): the permanentModelError
// subset must stay request-independent. A healthy model must never be parked
// for one bad request (review on #539). If you add a new modelError rule to
// errorConfig.js, decide here whether it is identity death (permanent) or
// request-scoped (not permanent) and pin it in PERMANENT / REQUEST_SCOPED.
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const PERMANENT = [
  "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
  "Model 'ag/gemini-3.7-flash-high' not found",
  "model_not_found",
  "Unknown model: foo-bar",
  "The model 'x' does not exist",
  "Invalid model 'x' specified",
  "Model is not available in your region",
  "endpoint is unavailable",
  "model is unavailable",
];

const REQUEST_SCOPED = [
  // 400-text capacity errors
  "content_length_exceeds_threshold",
  "This model's maximum context length is 128000 tokens, however you requested 200000 tokens.",
  "maximum context length exceeded",
  "exceed context limit",
  "exceeds the context window",
  "prompt is too long",
  "input is too long",
  "output_limit_exceeded",
  "cannot preserve full request context",
  "unsupported request: foo",
  "MODEL_TEMPORARILY_UNAVAILABLE",
];

describe("errorConfig: permanentModelError is identity death only", () => {
  for (const msg of PERMANENT) {
    it(`parks: "${msg.slice(0, 60)}…"`, () => {
      const r = checkFallbackError(400, msg);
      expect(r.modelError).toBe(true);
      expect(r.permanentModelError).toBe(true);
    });
  }

  for (const msg of REQUEST_SCOPED) {
    it(`never parks: "${msg.slice(0, 60)}…"`, () => {
      const r = checkFallbackError(400, msg);
      expect(r.modelError).toBe(true);
      expect(r.permanentModelError).toBe(false);
    });
  }

  it("status 404 parks (model not found); status 413 never parks (payload too large)", () => {
    const notFound = checkFallbackError(404, "Not Found");
    expect(notFound.modelError).toBe(true);
    expect(notFound.permanentModelError).toBe(true);

    const tooLarge = checkFallbackError(413, "Payload Too Large");
    expect(tooLarge.modelError).toBe(true);
    expect(tooLarge.permanentModelError).toBe(false);
  });
});
