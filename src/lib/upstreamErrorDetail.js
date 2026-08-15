// Extract a short, secret-free detail line from an upstream error body.
//
// Model-sync failures used to surface as a bare `Failed to fetch models: 403`,
// which makes a billing 403 ("out of credits") indistinguishable from an auth
// 403 ("token rejected") in the dashboard — the distinguishing text was logged
// server-side and then dropped. This pulls the useful sentence out of the body
// so the UI can show it.
//
// SECURITY MODEL — allowlist first, redaction only as defence in depth.
// A 401/403 body is exactly where an upstream is most likely to echo back the
// credential it just rejected, so the primary boundary is that we only ever emit
// values read from a KNOWN set of human-message fields, and never fall back to
// dumping a parsed payload we did not understand. Regex redaction runs on top of
// that, but is deliberately NOT treated as the boundary: a short denylist cannot
// enumerate every credential shape, and an over-broad one mangles the very
// messages this module exists to surface (both failure modes were observed in
// review — see the regression tests).

// Bound the work before any parsing/regex pass so a huge body cannot burn CPU.
const MAX_INPUT_LENGTH = 8192;
const MAX_DETAIL_LENGTH = 300;

// Fields upstreams actually use for the human-readable reason, in priority
// order. This is an ALLOWLIST — a field not named here is never emitted.
const MESSAGE_FIELDS = ["message", "error_description", "detail", "reason", "error", "code"];

// A field whose NAME looks credential-bearing is never emitted, even if it
// somehow collides with an allowlisted name.
const SECRET_FIELD_NAME = /token|secret|key|password|passwd|credential|authorization|cookie|session|signature/i;

// Words that follow a credential keyword but are plainly a STATE, not a value.
// Without this, "token: expired" redacts to "token [redacted]" — destroying the
// diagnostic the caller needs.
const BENIGN_VALUES = /^(?:missing|invalid|expired|revoked|absent|empty|null|none|required|unauthorized|malformed|unset|not|no)$/i;

/**
 * Redact anything that looks like a credential. Defence in depth only — the
 * allowlist in `pickMessage` is the actual boundary.
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
      // Full HTTP auth schemes — the scheme name must survive, its value must not.
      .replace(/\b(Basic|Bearer|Digest|Negotiate|Token)\s+[A-Za-z0-9+/=._~-]{8,}/g, "$1 [redacted]")
      // Keyword + explicit separator + value. Skips a benign state word so
      // "token: expired" stays readable.
      .replace(
        /\b(bearer|token|api[-_]?key|x-api-key|authorization|refresh[-_]?token|access[-_]?token|client[-_]?secret)\b\s*[:=]\s*"?([^\s",;}]+)"?/gi,
        (match, keyword, value) => (BENIGN_VALUES.test(value) ? match : `${keyword} [redacted]`)
      )
      // Vendor key formats. Each REQUIRES its real delimiter and a realistic
      // length — without the delimiter, `sk|gho` matched "skyscraper" and
      // "ghostwriter" and redacted ordinary prose.
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
      // Bare long hex runs (≥32) — machine ids, session tokens, digests.
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]")
  );
}

/**
 * Pull the first usable string out of an object shaped like an error payload.
 * Only allowlisted field names are considered, and any field whose name looks
 * credential-bearing is skipped outright.
 */
function pickMessage(obj, depth = 0) {
  if (typeof obj === "string") return obj;
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 2) return "";

  for (const field of MESSAGE_FIELDS) {
    if (SECRET_FIELD_NAME.test(field)) continue;
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    // `error` is frequently a nested object ({ error: { message, code } }).
    if (value && typeof value === "object") {
      const nested = pickMessage(value, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
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
 * nothing useful to show. Never throws — a malformed body must not convert an
 * upstream error into a 500 on our side.
 *
 * @param {string} body Raw response text from the upstream.
 * @returns {string} Redacted single-line detail, capped in length. "" if empty.
 */
export function extractUpstreamErrorDetail(body) {
  if (typeof body !== "string" || !body.trim()) return "";

  const bounded = body.length > MAX_INPUT_LENGTH ? body.slice(0, MAX_INPUT_LENGTH) : body;

  let detail = "";
  let parsedOk = false;
  try {
    const parsed = JSON.parse(bounded);
    parsedOk = true;
    detail = pickMessage(parsed);
  } catch {
    // Not JSON (HTML error page, plain text, truncated stream).
    detail = stripHtml(bounded);
  }

  // A payload that parsed but carried no allowlisted message field yields
  // NOTHING. Falling back to the raw body here would defeat the allowlist and
  // leak operational metadata (internal hostnames, request echoes, credentials
  // in unrecognised fields).
  if (parsedOk && !detail) return "";
  if (!detail) return "";

  detail = redactSecrets(detail).replace(/\s+/g, " ").trim();
  if (!detail) return "";

  return detail.length > MAX_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : detail;
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
