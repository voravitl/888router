// Lossless JSON whitespace compactor for MCP/API JSON tool outputs.
// Validates with JSON.parse first, then strips only insignificant JSON
// whitespace outside string literals so numbers, escapes, and key order
// remain exact and deterministic (prompt-cache safe).
import { FILTERS } from "../constants.js";

function isJsonWhitespace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** Fast structural check for JSON objects/arrays before invoking JSON.parse. */
export function looksLikeJson(text) {
  if (typeof text !== "string" || text.length < 2) return false;
  let start = 0;
  const n = text.length;
  while (start < n && isJsonWhitespace(text.charCodeAt(start))) start++;
  if (start >= n) return false;

  const first = text.charCodeAt(start);
  if (first !== 123 && first !== 91) return false; // '{' or '['

  let end = n - 1;
  while (end > start && isJsonWhitespace(text.charCodeAt(end))) end--;
  const last = text.charCodeAt(end);
  if ((first === 123 && last !== 125) || (first === 91 && last !== 93)) return false;

  let next = start + 1;
  while (next <= end && isJsonWhitespace(text.charCodeAt(next))) next++;
  if (next > end) return false;
  const ch = text[next];
  if (first === 123) return ch === '"' || ch === "}";
  return ch === '"' || ch === "{" || ch === "[" || ch === "]" || ch === "-" || ch === "t" || ch === "f" || ch === "n" || (ch >= "0" && ch <= "9");
}

/** True when `text` parses as a valid JSON object or array. */
export function isValidJsonContainer(text) {
  if (!looksLikeJson(text)) return false;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function stripJsonWhitespace(str) {
  const chunks = [];
  let i = 0;
  const n = str.length;

  while (i < n) {
    const code = str.charCodeAt(i);
    if (code === 34) {
      // '"' — copy string literal verbatim (preserving internal spaces and escapes)
      const start = i;
      i++;
      while (i < n) {
        const c = str.charCodeAt(i);
        if (c === 92) {
          i += 2;
          continue;
        }
        i++;
        if (c === 34) break;
      }
      chunks.push(str.slice(start, i));
    } else if (isJsonWhitespace(code)) {
      i++;
      while (i < n && isJsonWhitespace(str.charCodeAt(i))) i++;
    } else {
      const start = i;
      i++;
      while (i < n) {
        const c = str.charCodeAt(i);
        if (c === 34 || isJsonWhitespace(c)) break;
        i++;
      }
      chunks.push(str.slice(start, i));
    }
  }

  return chunks.join("");
}

/**
 * Minify valid JSON object/array outputs losslessly. Invalid JSON, primitives,
 * and already-compact JSON are returned untouched.
 */
export function jsonCompact(input) {
  if (!isValidJsonContainer(input)) return input;
  const out = stripJsonWhitespace(input);
  if (!out || out.length >= input.length) return input;
  return out;
}

jsonCompact.filterName = FILTERS.JSON_COMPACT;
