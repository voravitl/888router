// Fidelity gate for RTK filters.
//
// A filter may reformat tool output, but it must not silently drop material the
// model needs to answer: a URL it was asked to cite, a fenced code block, a
// version string, an error line, or a file path it may be told to open. When any
// of those present in the input is missing from the compressed output, the
// rewrite is refused and the original text is used instead.
//
// This is a safeguard, not a proof (same position OmniRoute documents): content
// that is capping-prone but not listed here — say the 11th grep match in a file —
// can still be dropped, with a "+N more" marker left behind for the model to see.

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const VERSION_RE = /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g;
// Path-like tokens: at least one separator, or a known source extension.
const PATH_RE = /(?:[\w.-]+\/){1,}[\w.-]+|[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|php|c|h|cpp|hpp|json|ya?ml|toml|md|sh|sql|css|html|swift|kt)\b/g;
// Lines that carry a failure the model must act on.
const FAILURE_LINE_RE = /^.*\b(?:error|failed|failure|exception|traceback|fatal|panic|cannot|denied)\b.*$/gim;

// Bounded so a hostile multi-megabyte blob cannot blow up the gate.
const MAX_TOKENS_CHECKED = 400;
const MAX_TOKEN_LENGTH = 400;

function collect(text, re, into) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null && into.size < MAX_TOKENS_CHECKED) {
    const token = (match[0] || "").trim();
    if (token.length > 0 && token.length <= MAX_TOKEN_LENGTH) into.add(token);
  }
}

function protectedTokens(text) {
  const tokens = new Set();
  collect(text, FENCED_CODE_RE, tokens);
  if (tokens.size >= MAX_TOKENS_CHECKED) return tokens;
  collect(text, URL_RE, tokens);
  if (tokens.size >= MAX_TOKENS_CHECKED) return tokens;
  collect(text, VERSION_RE, tokens);
  if (tokens.size >= MAX_TOKENS_CHECKED) return tokens;
  collect(text, PATH_RE, tokens);
  if (tokens.size >= MAX_TOKENS_CHECKED) return tokens;
  collect(text, FAILURE_LINE_RE, tokens);
  return tokens;
}

/**
 * True when `compressed` still carries every protected token from `original`.
 * Fail-open: an unexpected error returns true so RTK keeps its own fail-open
 * behaviour rather than dropping the compression for an unrelated reason.
 */
export function preservesProtectedContent(original, compressed) {
  if (typeof original !== "string" || typeof compressed !== "string") return true;
  if (compressed === original) return true;
  try {
    for (const token of protectedTokens(original)) {
      if (!compressed.includes(token)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

export const __test__ = { protectedTokens };
