// Extract a short, secret-free detail line from an upstream error body.
//
// Model-sync failures used to surface as bare `Failed to fetch models: 403`,
// which makes a billing 403 ("out of credits") indistinguishable from an auth
// 403 ("token rejected") in the dashboard — the distinguishing text was logged
// server-side and then dropped. This pulls the useful sentence out of the body
// so the UI can show it, without leaking credentials that upstreams sometimes
// echo back in their error payloads.

const MAX_DETAIL_LENGTH = 300;

// Fields upstreams actually use for the human-readable reason, in priority
// order. Checked both at the top level and one level down under `error`.
const MESSAGE_FIELDS = ["message", "error_description", "detail", "reason", "error", "code"];

/**
 * Redact anything that looks like a credential. Upstream error bodies echo the
 * rejected token often enough that this is not hypothetical — a 401/403 body is
 * exactly where a key is most likely to appear.
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return "";
  return text
    // Keyword followed by an explicit `:`/`=` separator — a header or field, so
    // whatever follows is the value. The inner optional scheme keyword matters:
    // without it, "Authorization: Bearer <token>" has its \S+ satisfied by
    // "Bearer" and leaks the token after it.
    .replace(
      /\b(bearer|token|api[-_]?key|x-api-key|authorization)\b\s*[:=]\s*(?:(?:bearer|token)\s+)?\S+/gi,
      "$1 [redacted]"
    )
    // Keyword followed by a bare value with no separator. Requires a
    // credential-shaped run (≥16 chars) so ordinary prose survives — without the
    // length floor, "access token could not be validated" redacts the word
    // "could" and mangles the very messages this module exists to surface.
    .replace(/\b(bearer|token)\s+([A-Za-z0-9._-]{16,})/gi, "$1 [redacted]")
    // Vendor key formats: sk-..., xai-..., ghp_..., AIza...
    .replace(/\b(?:sk|xai|ghp|gho|github_pat|AIza)[-_A-Za-z0-9]{8,}/g, "[redacted]")
    // JWTs
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted]")
    // Bare long hex/base64-ish runs (≥32) — machine ids, session tokens
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]");
}

/** Pull the first usable string out of an object shaped like an error payload. */
function pickMessage(obj, depth = 0) {
  if (typeof obj === "string") return obj;
  if (!obj || typeof obj !== "object" || depth > 2) return "";

  for (const field of MESSAGE_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    // `error` is frequently a nested object ({ error: { message, code } })
    if (value && typeof value === "object") {
      const nested = pickMessage(value, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
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

  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = pickMessage(parsed);
  } catch {
    // Not JSON (HTML error page, plain text, truncated stream) — use the text.
    detail = body;
  }
  if (!detail) detail = body;

  // Collapse whitespace so an HTML page or pretty-printed JSON stays one line.
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
