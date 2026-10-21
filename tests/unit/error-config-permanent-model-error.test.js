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
  // 410 / ModelDeprecated (2026-10-21): a retired model id upstream. The
  // model identity is dead, the transport is healthy — so it must never
  // rotate accounts or park a shared proxy pool.
  "Model muse-spark-1.3-contributor-free has been deprecated.",
  '{"type":"error","error":{"type":"ModelDeprecated","message":"Model X has been deprecated."}}',
  // 400 / ModelProtocolUnsupported: same class — the model cannot serve this
  // endpoint, the relay can. Matched on text, never on the bare 400 status.
  '{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}',
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
  // "not found" WITHOUT "model" = account/client-side, never park the model:
  "API key not found",
  "account not found",
  "organization not found",
  "project not found",
  "Requested entity was not found.",
  // A GENERIC 400 is not a model error. The ModelProtocolUnsupported rule is
  // matched on text precisely so a plain bad request still rotates instead
  // of parking a shared proxy pool on a request-shaped failure.
  "Invalid request: missing required parameter 'messages'.",
  "Invalid JSON in tool arguments",
];

const COMPOUND_IDENTITY = [
  // The model id sits BETWEEN the keywords, so no single-substring text rule
  // can match these — the compound check in checkFallbackError catches them.
  "Model 'ag/gemini-3.7-flash-high' not found",
  "The model 'gpt-6-sol' was not found",
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
      // The pinned invariant is "not permanent" (never park). Absent field
      // (transient default) counts as not permanent — only an explicit true
      // may park. modelError itself is the classifier's business.
      expect(r.permanentModelError).not.toBe(true);
    });
  }

  for (const msg of COMPOUND_IDENTITY) {
    it(`parks via compound check: "${msg.slice(0, 60)}…"`, () => {
      const r = checkFallbackError(400, msg);
      expect(r.modelError).toBe(true);
      expect(r.permanentModelError).toBe(true);
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

  it("status 410 parks (model retired upstream) and never rotates accounts", () => {
    // A dead model id must not take the shared relay down with it: the
    // opencode relay is shared by every `oc/*` model, so rotating/parking it
    // on one retired id killed every sibling model too (2026-10-21).
    const gone = checkFallbackError(410, "Gone");
    expect(gone.modelError).toBe(true);
    expect(gone.permanentModelError).toBe(true);
    expect(gone.shouldFallback).toBe(false);
    expect(gone.cooldownMs).toBe(0);
  });
});
