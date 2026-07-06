/**
 * Per-route API logging wrapper.
 *
 * Wrap a Next.js App Router route handler with `withLogging` to emit structured
 * request/response logs. Opt-in per route — NOT a replacement for Next.js's
 * built-in logging. Designed to surface silent auth failures (bug #d11fb12)
 * and other 4xx/5xx responses that would otherwise vanish.
 *
 * Logs go through `console.log/warn/error` so they're captured by the existing
 * consoleLogBuffer + server stdout like the rest of `[API]` output.
 */

function logStart(method, url, routeName) {
  console.log(`[API] ${method} ${url} — ${routeName}`);
}

function logEnd(method, url, statusCode, durationMs) {
  console.log(`[API] ${method} ${url} → ${statusCode} (${durationMs}ms)`);
}

function logError(method, url, err) {
  console.error(`[API] ${method} ${url} ✗ ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
}

/**
 * Inspect a Next.js handler return value for a status code.
 * App Router handlers return either a Response (NextResponse) or sometimes
 * a plain object in tests. Returns undefined when not determinable.
 */
function statusCodeOf(result) {
  if (!result) return undefined;
  if (typeof result.status === "number") return result.status;
  if (typeof result.status === "function") {
    try { return result.status(); } catch {}
  }
  // No status() method → don't assume 200; let end-log show (unknown).
  return undefined;
}

// Patterns redacted from logged response bodies to prevent credential/PII
// leakage if `withLogging` is ever wired to a route whose error body echoes
// secrets (auth, settings, db). Matches JSON keys and Authorization headers.
const REDACT_PATTERNS = [
  /("(?:apiKey|password|token|secret|authorization)"\s*:\s*)"[^"]*"/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._\-]+/gi,
];
const REDACT_MAX_BODY_LEN = 500;

function redactBody(text) {
  let out = text;
  for (const re of REDACT_PATTERNS) {
    out = out.replace(re, (_, p1) =>
      p1 ? `${p1}"[redacted]"` : "[redacted]",
    );
  }
  if (out.length > REDACT_MAX_BODY_LEN) {
    out = `${out.slice(0, REDACT_MAX_BODY_LEN)}…[truncated]`;
  }
  return out;
}

/**
 * For 4xx/5xx responses, log the body so silent auth/quota failures are
 * debuggable. Body is redacted + length-capped to avoid leaking credentials.
 */
async function logBodyIfErrorStatus(method, url, status, result) {
  if (status === undefined || status < 400) return;
  if (!result || typeof result.text !== "function") {
    console.warn(`[API] ${method} ${url} ${status} (no inspectable body)`);
    return;
  }
  // NextResponse.text() clones internally; safe to read here.
  let bodyText;
  try { bodyText = await result.text(); }
  catch {
    console.warn(`[API] ${method} ${url} ${status} (body read failed)`);
    return;
  }
  console.warn(`[API] ${method} ${url} ${status} body=${redactBody(bodyText)}`);
}

/**
 * Wrap an App Router route handler with structured logging.
 *
 * @param {function} handler - async (request, ctx) => Response
 * @param {string} routeName - human label, e.g. "GET /api/usage/summary"
 * @returns {function} wrapped handler with the same signature
 */
export function withLogging(handler, routeName) {
  return async function loggedHandler(request, ctx) {
    const method = request?.method || "UNKNOWN";
    const url = request?.url || "";
    logStart(method, url, routeName);
    const startedAt = Date.now();
    try {
      const result = await handler(request, ctx);
      const duration = Date.now() - startedAt;
      const status = statusCodeOf(result);
      logEnd(method, url, status ?? 200, duration);
      await logBodyIfErrorStatus(method, url, status, result);
      return result;
    } catch (err) {
      const duration = Date.now() - startedAt;
      logEnd(method, url, 500, duration);
      logError(method, url, err);
      throw err;
    }
  };
}
