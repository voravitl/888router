// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

// How long a proxy pool is held OUT of rotation after its host suspended the
// deployment for exceeding a usage quota.
//
// This is deliberately separate from checkFallbackError's cooldownMs. Those are
// two different clocks and conflating them breaks one of the two:
//   - cooldownMs (short, 5s) paces the hop to the NEXT pool inside a single
//     request — combo.js waits it out before falling through (see the transient
//     5xx wait there). Making it long stalls the request.
//   - POOL_SUSPEND_PARK_MS keeps the dead relay from being handed back on
//     LATER requests. A suspended relay stays down until its quota window
//     resets (hours), so parking it for seconds means rotation keeps returning
//     to it indefinitely.
export const POOL_SUSPEND_PARK_MS = 30 * 60 * 1000;

/**
 * True when an error means "this relay/proxy host has suspended the deployment"
 * (Deno Deploy / Vercel quota suspension), as opposed to a transient 5xx.
 * Used to pick the long park window above; never to decide fallback.
 */
export function isRelaySuspendError(status, errorText) {
  const t = typeof errorText === "string"
    ? errorText.toLowerCase()
    : (errorText ? String(errorText).toLowerCase() : "");
  if (!t) return false;
  return t.includes("usage_exceeded") || t.includes("is suspended");
}

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, noFallback? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - noFallback: true = error is not account-specific (e.g. a gateway
 *     input-size limit); do not rotate accounts or lock the account —
 *     surface the error to the client instead.
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---

  // Model-level errors: model doesn't exist or isn't supported upstream.
  // Retrying with another account of the same provider is pointless (same
  // model = same error). Account-level: shouldFallback=false (skip accounts).
  // Combo-level: modelError=true → skip to next model immediately.
  { text: "not supported",    modelError: true },
  { text: "model not found",  modelError: true },
  { text: "model_not_found",  modelError: true },
  { text: "unknown model",    modelError: true },
  { text: "does not exist",   modelError: true },
  { text: "invalid model",    modelError: true },
  { text: "not available in", modelError: true },
  // Model-level transient overload (e.g. Kiro 500 "reason": "MODEL_TEMPORARILY_UNAVAILABLE").
  // Retrying with another account of the same provider is pointless — the model
  // is overloaded for everyone. Model-level: combo skips to next model, and a
  // single-model request surfaces the error (after the executor's single in-place
  // 500 retry, see DEFAULT_RETRY_CONFIG.500). Matched on the lowercased error
  // text, so use the underscore spelling of Kiro's exact reason.
  { text: "model_temporarily_unavailable", modelError: true },

  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Gateway input-size limit — not account-specific. KiroExecutor reactively
  // shrinks + retries on the same account first; if it still surfaces, rotating
  // accounts is futile (identical payload, same wall), so do not fall back or
  // lock the account — surface the 400 to the client.
  { text: "content_length_exceeds_threshold", noFallback: true },
  { text: "rate limit",               backoff: true },
  // Relay host suspended the deployment for exceeding its usage quota (Deno
  // Deploy / Vercel: 503 "(USAGE_EXCEEDED) This application is suspended due to
  // usage limits being exceeded"). Kept ABOVE the "usage limit" rule below:
  // that rule's substring also matches this message ("usage limits") and rules
  // are first-match-wins, so a suspended relay was being classified as an
  // escalating rate limit instead. cooldownMs stays SHORT on purpose — it only
  // paces the hop to the next pool within one request; the long quarantine that
  // keeps a dead relay out of later rotations is POOL_SUSPEND_PARK_MS.
  { text: "usage_exceeded",           cooldownMs: COOLDOWN.short, parkMs: POOL_SUSPEND_PARK_MS },
  { text: "is suspended",             cooldownMs: COOLDOWN.short, parkMs: POOL_SUSPEND_PARK_MS },
  { text: "usage limit",              backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  // 404 = model not found → don't cycle accounts, let combo skip to next model
  { status: 404, modelError: true },
  { status: 429, backoff: true },
  // 503/502/504 transient — shouldFallback so account layer rotates pools,
  // but short cooldown so combo doesn't stall on one exhausted proxy relay.
  { status: 503, cooldownMs: COOLDOWN.short },
  { status: 502, cooldownMs: COOLDOWN.short },
  { status: 504, cooldownMs: COOLDOWN.short },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
