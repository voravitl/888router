// Classify an upstream error into one of OUR OWN fixed explanations.
//
// PROBLEM (#279): model-sync failures surfaced as a bare `Failed to fetch
// models: 403`, so a billing 403 ("out of credits") and an auth 403 ("token
// rejected") were the same string in the dashboard. That is what made #272 hard
// to diagnose — no token refresh can clear a billing 403, but nothing said so.
//
// ── WHY THIS DOES NOT PASS UPSTREAM TEXT THROUGH ────────────────────────────
//
// The obvious design is "emit the upstream's message, redacted". Three review
// rounds killed it. A 401/403 body is the most likely place for an upstream to
// echo back the credential it just rejected, and every iteration of the
// sanitizer lost to a new evasion: a bare top-level JSON string bypassed the
// field allowlist; slicing before parsing turned valid JSON into raw text that
// leaked the guarded fields; a NUL byte flipped JSON detection to plain text; a
// control character inside `Bear<ESC>er` defeated the pattern and was then
// stripped back into a working credential; `password: "correct horse battery
// staple"` left three words behind; `cookie: a=1; b=secret` left the second
// pair. Meanwhile the over-broad direction was just as bad — the redactor ate
// `skyscraper`, `ghostwriter`, `invalid bearer credentials`, and turned
// `access token could not be validated` into `access token [redacted] not be
// validated`, destroying the diagnostic the feature exists to deliver.
//
// A denylist over adversarial text is the wrong shape for this. So:
//
// **No byte of the upstream body is ever emitted.** The body is only ever
// *matched against* to pick a key from a fixed table, and the text that ships is
// written here. A credential in the body cannot be printed, because printing the
// body is not a code path that exists.
//
// This is fail-safe: an unrecognised body yields no key, and the caller falls
// back to the bare status — exactly the pre-#279 message. Evasion therefore
// costs an attacker a *less* informative error, never a disclosure.

// Reasons we can state, keyed by a stable identifier. The `text` values are OURS
// and are the only EXPLANATIONS this module can return. Stated precisely, the
// module's output guarantee is: no body content and no arbitrary status text is
// ever copied into the output — everything emitted is a module-authored literal
// (these values, the `Failed to fetch models:` template, a reason key, or
// "unknown status") plus validated numeric metadata (a 100-599 status and the
// body's length).
const REASONS = {
  billing: "out of credits or subscription required (billing, not auth — refreshing the token will not help)",
  quota: "usage quota or rate limit exceeded — retry later",
  auth_invalid: "credentials rejected by the upstream — re-authenticate this connection",
  auth_expired: "credentials expired and could not be refreshed — re-authenticate this connection",
  auth_missing: "no credentials were accepted — check the connection is configured",
  permission: "this account lacks permission for the models endpoint",
  not_found: "the models endpoint was not found at this base URL",
  unsupported: "the upstream does not support listing models",
  server: "the upstream reported a server-side error — retry later",
  unavailable: "the upstream is temporarily unavailable or overloaded — retry later",
  timeout: "the upstream timed out",
  network: "could not reach the upstream — check the base URL and network",
  blocked: "the request was blocked by the upstream (region, policy, or firewall)",
};

// Signals matched against the NORMALISED body. Order matters: the first match
// wins, so the more specific and more actionable reasons come first. Billing
// leads because it is the case that looks like auth and is not.
const SIGNALS = [
  [/out of credits|no credits|insufficient (?:credits|balance|funds|quota)|spending[- ]?limit|payment required|subscription (?:required|expired)|billing|past due|add credits|top ?up|upgrade your plan/, "billing"],
  [/rate ?limit|too many requests|quota (?:exceeded|exhausted)|usage limit|throttl|resource[- ]?exhausted/, "quota"],
  // Must name the CREDENTIAL as the thing that expired. A bare /expired/ also
  // caught "certificate expired" and "cache expired", which are not auth
  // problems and send the user to re-authenticate for nothing.
  [/(?:token|credentials?|key|session|grant|authorization|jwt|login)\b[^.]{0,20}\bexpired|expired[^.]{0,20}\b(?:token|credentials?|key|session|grant)/, "auth_expired"],
  [/invalid[_ ]?(?:api[_ ]?)?key|incorrect api key|invalid token|invalid[_ ]?grant|invalid credentials?|authentication[_ ]?(?:failed|error)|could not be validated|unauthenticated|bad credentials|signature (?:mismatch|invalid)|revoked/, "auth_invalid"],
  [/missing (?:api ?key|token|credential|authorization)|no (?:api ?key|token|credentials?) (?:provided|supplied|found)|api ?key (?:is )?required|authorization (?:header )?required/, "auth_missing"],
  // A bare /scope/ matched "microscope" and beat the authoritative 404 fallback
  // on "model microscope-v2 not found", so the scope signal needs its context.
  // MUST precede BOTH `permission` and `unsupported`. A geo block arrives worded
  // as a generic 403 with the region detail trailing — "Forbidden: region not
  // supported", "access denied by regional policy" — so /forbidden/ and
  // /access denied/ claimed them first and told the user to fix permissions on an
  // account that has them. The word boundaries matter too: a bare /blocked/
  // matched "unblocked" and /geo/ matched "geometry".
  [/\bblocked\b|\bgeo(?:graphic|graphical|blocking|-?restricted)?\b|region(?:al)? (?:not )?(?:supported|restricted|policy)|country (?:not )?(?:supported|allowed)|firewall|policy violation|denied by (?:the )?(?:regional |geo|country |network )?(?:policy|firewall|gateway|proxy|cdn|waf)/, "blocked"],
  [/permission|forbidden|not authorized|unauthorized_client|insufficient (?:permission|scope|privileges)|access denied|\b(?:missing|invalid|insufficient|required) scopes?\b|\bscopes? (?:missing|invalid|required|insufficient)\b/, "permission"],
  [/not found|no such (?:model|endpoint|route)|unknown (?:model|endpoint)|404|does not exist/, "not_found"],
  // MUST precede `unsupported`: "region not supported" and "country not
  // supported" are geo blocks, but /not supported/ claimed them first and told
  // the user model listing itself was unsupported. The word boundaries matter
  // too — a bare /blocked/ matched "unblocked" and /geo/ matched "geometry".
  [/not supported|unsupported|not implemented|method not allowed/, "unsupported"],
  [/timed? ?out|timeout|deadline exceeded|etimedout/, "timeout"],
  [/unavailable|overloaded|high load|capacity|try again later|temporarily|maintenance|503/, "unavailable"],
  [/econnrefused|enotfound|dns|connect(?:ion)? (?:refused|error|reset)|socket hang ?up|network/, "network"],
  [/internal (?:server )?error|server error|bad gateway|upstream error|exception|traceback/, "server"],
];

// Status-only fallback: when the body says nothing we recognise, the status code
// itself still distinguishes broad classes.
const STATUS_REASONS = {
  401: "auth_invalid",
  402: "billing",
  403: "permission",
  404: "not_found",
  405: "unsupported",
  408: "timeout",
  429: "quota",
  501: "unsupported",
  502: "unavailable",
  503: "unavailable",
  504: "timeout",
};

// Invisible characters an adversarial body can hide inside a keyword to defeat
// matching (`Bear<ZWSP>er`). Built from codepoints so this source file never
// contains a literal control character. C0, DEL+C1, bidi marks/overrides, ALM,
// zero-width space/joiners, word joiner, and BOM.
// Bound on how much of the body is examined. Applied by slicing FIRST, before
// any whole-string operation, so a multi-megabyte body cannot buy unbounded work.
const MAX_MATCH_LENGTH = 16384;

const INVISIBLE_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x061c, 0x061c], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const INVISIBLE = new RegExp(
  "[" + INVISIBLE_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join("") + "]",
  "g"
);

/**
 * Fold a body into a form that is hard to hide keywords in. Invisible characters
 * are DELETED (so `Bear<ZWSP>er` becomes `Bearer`) before matching, which closes
 * the evasion without needing the result to be safe to print — it never is
 * printed.
 */
function normalize(body) {
  return String(body).replace(INVISIBLE, "").replace(/\s+/g, " ").toLowerCase();
}

/**
 * Coerce a status into a plain integer, or null when it is not a usable HTTP
 * status. Nothing derived from the argument is ever emitted — callers print
 * either this integer or a fixed placeholder.
 *
 * This exists because the argument is NOT trustworthy just for being called a
 * status. `Number(x)` invokes `valueOf`, and template interpolation invokes
 * `toString`; an object can answer 403 to one and a secret to the other, which
 * put attacker text into the output through the status parameter while the body
 * path stayed clean. A `Symbol` threw outright. Accept primitives only.
 */
function toStatusCode(status) {
  if (typeof status === "number") {
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }
  // Length-check BEFORE trim() so a huge string cannot buy work here either. A
  // real status is 3 chars; anything longer than a little whitespace is not one.
  if (typeof status === "string" && status.length <= 16) {
    const trimmed = status.trim();
    if (/^[1-5]\d{2}$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

/** Printable form of a status: the integer, or a fixed placeholder. */
function statusLabel(code) {
  return code === null ? "unknown status" : String(code);
}

/**
 * Identify why an upstream call failed, as a key into REASONS.
 *
 * @param {number} status HTTP status from the upstream.
 * @param {string} body Raw response text. Matched against, never emitted.
 * @returns {string|null} A REASONS key, or null when nothing is recognised.
 */
export function classifyUpstreamError(status, body) {
  // Slice BEFORE any full-string operation so the work is genuinely bounded.
  if (typeof body === "string" && body.length > 0) {
    const haystack = normalize(body.slice(0, MAX_MATCH_LENGTH));
    if (haystack.trim()) {
      for (const [pattern, reason] of SIGNALS) {
        if (pattern.test(haystack)) return reason;
      }
    }
  }
  const code = toStatusCode(status);
  if (code === null) return null;
  // Own-property lookup only. A polluted Object.prototype could otherwise plant
  // a numeric key here and steer an unknown status to a wrong reason.
  if (Object.hasOwn(STATUS_REASONS, code)) return STATUS_REASONS[code];
  return code >= 500 ? "server" : null;
}

/**
 * Human-readable explanation for a failed upstream call, or "" when we cannot
 * say anything specific. The returned string is always one of ours.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function explainUpstreamError(status, body) {
  const reason = classifyUpstreamError(status, body);
  // Own-property lookup, same reason as above: the emitted string must come from
  // OUR table, never from something planted on Object.prototype.
  return reason && Object.hasOwn(REASONS, reason) ? REASONS[reason] : "";
}

/**
 * Build the client-facing error for a failed upstream models fetch. Falls back
 * to the bare status when nothing is recognised, so the message never regresses
 * below what it was before #279.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function formatModelsFetchError(status, body) {
  const detail = explainUpstreamError(status, body);
  const label = statusLabel(toStatusCode(status));
  return detail ? `Failed to fetch models: ${label} — ${detail}` : `Failed to fetch models: ${label}`;
}

/**
 * Server-log form. The raw body used to be logged verbatim, which persists any
 * echoed credential to disk. Log the classification and a length instead —
 * reported as UTF-16 code units, which is what String#length counts; calling it
 * bytes would be wrong for any non-ASCII body, and computing real UTF-8 bytes
 * would mean scanning the whole body and giving up the bounded-work property —
 * enough to correlate with the upstream, nothing quotable.
 *
 * @param {number} status
 * @param {string} body
 * @returns {string}
 */
export function safeLogDetail(status, body) {
  const reason = classifyUpstreamError(status, body);
  const codeUnits = typeof body === "string" ? body.length : 0;
  return `status=${statusLabel(toStatusCode(status))} reason=${reason || "unclassified"} body=${codeUnits}codeUnits (not logged)`;
}

/** Exported for tests: the fixed set of strings this module can emit. */
export const UPSTREAM_ERROR_REASONS = Object.freeze({ ...REASONS });
