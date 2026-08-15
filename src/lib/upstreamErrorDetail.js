// Extract a short detail line from an upstream error body.
//
// Model-sync failures used to surface as a bare `Failed to fetch models: 403`,
// which makes a billing 403 ("out of credits") indistinguishable from an auth
// 403 ("token rejected") in the dashboard — the distinguishing text was logged
// server-side and then dropped. This pulls the useful sentence out of the body
// so the UI can show it.
//
// ── SECURITY MODEL, AND ITS HONEST LIMIT ────────────────────────────────────
//
// The boundary is a FIELD ALLOWLIST: only values read from a known set of
// human-message fields are emitted. A payload that parses without one yields
// NOTHING — no raw-body fallback, because that fallback is what would surface
// internal hostnames, request echoes, and credentials sitting in unrecognised
// fields. A body that looks like JSON but fails to parse (truncated, malformed,
// oversized) is withheld for the same reason.
//
// Regex redaction runs on top as defence in depth, never as the boundary: a
// short denylist cannot enumerate every credential shape, and an over-broad one
// mangles the very messages this module exists to surface. Both failure modes
// were found in review — see the regression tests.
//
// LIMIT, stated plainly: an upstream's own `message` string is TRUSTED BY
// CONTRACT to be human-facing prose. If an upstream writes a raw credential into
// its human message field, no finite regex reliably catches it — "the rejected
// value is hunter2" has no detectable shape. This module does NOT claim to make
// arbitrary upstream prose provably secret-free. It claims: we never emit
// payload regions we did not recognise, and we redact the credential shapes that
// are recognisable. Anything stronger would require per-provider enumerated
// error codes instead of pass-through prose, which loses the diagnostic this
// module exists to deliver.

// A JSON body is parsed WHOLE, never sliced first: slicing a valid JSON body
// makes it malformed, which used to divert it to the plain-text path and emit
// the unknown fields the allowlist exists to suppress. The cap below bounds
// parse cost; a JSON-shaped body above it is withheld rather than degraded.
const MAX_PARSE_LENGTH = 262144;
// Plain-text bodies carry no field structure to protect, so they are simply
// bounded before the regex passes run.
const MAX_TEXT_LENGTH = 8192;
const MAX_DETAIL_LENGTH = 300;

// Fields upstreams actually use for the human-readable reason, in priority
// order. This is an ALLOWLIST — a field not named here is never emitted.
const MESSAGE_FIELDS = ["message", "error_description", "detail", "reason", "error", "code"];

// A field whose NAME looks credential-bearing is never traversed, even if it
// somehow collides with an allowlisted name.
const SECRET_FIELD_NAME =
  /token|secret|key|password|passwd|credential|authorization|cookie|session|signature/i;

// Words that follow a credential keyword but are plainly a STATE, not a value.
// Without this, "token: expired" redacts to "token [redacted]" — destroying the
// diagnostic the caller needs.
const BENIGN_VALUES =
  /^(?:missing|invalid|expired|revoked|absent|empty|null|none|required|unauthorized|forbidden|malformed|unset|rejected|not|no)$/i;

/**
 * Is the captured value a state word rather than a credential? Trailing
 * punctuation is stripped first — "token: expired." must behave like
 * "token: expired", or the diagnostic gets redacted over a full stop.
 */
function isBenignValue(value) {
  return BENIGN_VALUES.test(String(value).replace(/[.,;:!?)\]}'"]+$/, ""));
}

// Non-printing control characters. Built from codepoints at runtime so this
// SOURCE FILE never contains a literal control character itself. An ANSI escape
// in an upstream message can clear a terminal or hide adjacent log lines, and
// Unicode bidi overrides can visually reorder text; neither belongs in
// something we log or render. Covers C0 (minus \t\n\r, which whitespace
// normalisation folds anyway), DEL + C1, and the bidi control ranges.
const CONTROL_CHAR_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const CONTROL_CHARS = new RegExp(
  "[" +
    CONTROL_CHAR_RANGES.map(([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`).join("") +
    "]",
  "g"
);

/**
 * Redact anything that looks like a credential. Defence in depth only — the
 * field allowlist in `pickMessage` is the actual boundary.
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return "";
  return (
    text
      // Quoted JSON field whose NAME looks credential-bearing:
      //   "access_token": "..." / "client_secret": "..." / "api_key": "..."
      .replace(
        /("(?:[A-Za-z0-9_.-]*(?:token|secret|key|password|passwd|credential|authorization|cookie|session|signature)[A-Za-z0-9_.-]*)"\s*:\s*)"[^"]*"/gi,
        '$1"[redacted]"'
      )
      // Full HTTP auth schemes — the scheme name survives, its value must not.
      // Case-insensitive: a lowercase `bearer abc…` is just as much a credential.
      // A plain lowercase dictionary word is spared unless it is long enough to
      // be a token anyway: "invalid bearer credentials supplied" must survive,
      // while "Bearer someopaquetokenvalue" must not. Anything carrying digits,
      // padding, or mixed case is treated as a value at 8+ chars.
      .replace(/\b(Basic|Bearer|Digest|Negotiate|Token)(\s+)([A-Za-z0-9+/=._~-]{8,})/gi, (match, scheme, gap, value) => {
        const looksLikeWord = /^[a-z]+$/.test(value) && value.length < 16;
        return looksLikeWord || isBenignValue(value) ? match : `${scheme}${gap}[redacted]`;
      })
      // Keyword + separator + value. The separator may be `:`/`=` OR plain
      // whitespace ("API key abc…" is as common as "api_key=abc…"), and the
      // keyword itself may be spaced ("api key"). A benign state word is left
      // alone so "token: expired" stays readable.
      // (a) Explicit `:`/`=` separator — this is a field, so whatever follows is
      // its value, whatever it looks like. Benign state words are spared.
      .replace(
        /\b(bearer|token|api[-_ ]?key|x-api-key|authorization|refresh[-_ ]?token|access[-_ ]?token|client[-_ ]?secret|password|passwd|cookie|session[-_ ]?id|signature|credential)\b\s*[:=]\s*"?([^\s",;}]+)"?/gi,
        (match, keyword, value) => (isBenignValue(value) ? match : `${keyword} [redacted]`)
      )
      // (b) Whitespace separator only — ambiguous, because English prose puts
      // ordinary words after these nouns. Requires a credential-SHAPED run (>=16
      // chars, no spaces) so "access token could not be validated" survives
      // while "API key abcdefghijklmnop" does not. Without this floor the
      // redactor mangles the exact messages this module exists to surface.
      .replace(
        /\b(bearer|token|api[-_ ]?key|x-api-key|refresh[-_ ]?token|access[-_ ]?token|client[-_ ]?secret|password|passwd|credential)\s+"?([A-Za-z0-9+/=._~-]{16,})"?/gi,
        (match, keyword, value) => (isBenignValue(value) ? match : `${keyword} [redacted]`)
      )
      // Vendor key formats. Each REQUIRES its real delimiter and a realistic
      // length — without the delimiter, `sk|gho` matched the ordinary words
      // "skyscraper" and "ghostwriter" and redacted plain prose.
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .replace(/\bxai-[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, "[redacted]")
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}/g, "[redacted]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[redacted]")
      .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]")
      .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
      // JWTs
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]")
      // Bare long hex runs (>=32) — machine ids, session tokens, digests.
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]")
  );
}

/**
 * Pull the first usable string out of an object shaped like an error payload.
 * Only allowlisted field names are read, and a field whose name looks
 * credential-bearing is skipped outright.
 *
 * Takes an OBJECT only. A bare top-level JSON string (`"hunter2"`) is not a
 * recognised payload and must not be emitted — it has no field to allowlist,
 * so treating it as a message would bypass the boundary entirely.
 */
function pickMessage(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 2) return "";

  for (const field of MESSAGE_FIELDS) {
    if (SECRET_FIELD_NAME.test(field)) continue;
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    // `error` is frequently a nested object ({ error: { message, code } }).
    if (value && typeof value === "object") {
      const nested = pickMessage(value, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
}

/** Does this body claim to be JSON? Used to decide withhold-vs-plain-text. */
function looksLikeJson(trimmed) {
  return /^[{[\]"]/.test(trimmed) || /^(?:true|false|null|-?\d)/.test(trimmed);
}

/** Reduce an HTML error page to its text so a 502 page still says "502". */
function stripHtml(text) {
  if (!/<[a-z!/][^>]*>/i.test(text)) return text;
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/**
 * Turn a raw upstream error body into a single safe line, or "" when there is
 * nothing safely showable. Never throws — a malformed body must not convert an
 * upstream error into a 500 on our side.
 *
 * @param {string} body Raw response text from the upstream.
 * @returns {string} Redacted single-line detail, capped in length. "" if none.
 */
export function extractUpstreamErrorDetail(body) {
  if (typeof body !== "string") return "";
  const trimmed = body.trim();
  if (!trimmed) return "";

  let detail = "";

  if (looksLikeJson(trimmed)) {
    // JSON-shaped: the allowlist governs. Anything that cannot be parsed and
    // read through the allowlist is withheld rather than degraded to raw text.
    if (trimmed.length > MAX_PARSE_LENGTH) return "";
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return "";
    }
    detail = pickMessage(parsed);
    if (!detail) return "";
  } else {
    // Genuinely non-JSON (HTML error page, plain text, proxy message). There is
    // no field structure to protect here; bound it and let redaction run.
    detail = stripHtml(trimmed.slice(0, MAX_TEXT_LENGTH));
  }

  detail = redactSecrets(detail).replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  if (!detail) return "";

  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…` : detail;
}

/**
 * Build the client-facing error string for a failed upstream models fetch.
 * Falls back to the bare status when the body carries nothing usable, so the
 * message never regresses below what it was before.
 *
 * @param {number} status HTTP status from the upstream.
 * @param {string} body Raw response text.
 * @returns {string}
 */
export function formatModelsFetchError(status, body) {
  const detail = extractUpstreamErrorDetail(body);
  return detail ? `Failed to fetch models: ${status} — ${detail}` : `Failed to fetch models: ${status}`;
}

/**
 * Server-log form of an upstream error body. The raw body was previously logged
 * verbatim, which persists any credential the upstream echoed back into the log
 * file — inconsistent with this module's own premise. Log the sanitized detail
 * instead; when nothing survives the allowlist, say so rather than dumping it.
 *
 * @param {string} body Raw response text.
 * @returns {string}
 */
export function safeLogDetail(body) {
  const detail = extractUpstreamErrorDetail(body);
  if (detail) return detail;
  const length = typeof body === "string" ? body.length : 0;
  return `<no recognisable message; ${length} bytes withheld>`;
}
