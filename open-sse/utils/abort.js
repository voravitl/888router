/**
 * Client-abort detection.
 *
 * Next.js aborts `request.signal` with `new ResponseAborted()` (name
 * "ResponseAborted", empty message) when the client disconnects — not with a
 * DOMException "AbortError". A bare `error.name === "AbortError"` check
 * therefore misses a real client abort, and the failure gets recorded as a
 * provider 502 "Unknown error" that parks accounts/pools (#517).
 *
 * The signal itself is the reliable source of truth; the error names cover
 * callers that only have the thrown error.
 */
const CLIENT_ABORT_ERROR_NAMES = new Set(["AbortError", "ResponseAborted"]);

/**
 * True when `error` is, or was caused by, the client going away.
 * @param {unknown} error - the thrown/returned failure (may be null)
 * @param {AbortSignal|null} [signal] - the client's request signal, if known
 */
export function isClientAbort(error, signal = null) {
  if (signal?.aborted) return true;
  return CLIENT_ABORT_ERROR_NAMES.has(error?.name);
}
