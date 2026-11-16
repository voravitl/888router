// Lossless ANSI escape stripping + carriage-return (\r) progress-frame collapse.
// Preserves CRLF (\r\n) line endings and leaves normal text/code without ANSI or
// standalone \r byte-identical. Deterministic so prompt caches never invalidate.
import { FILTERS } from "../constants.js";

// ECMA-48 CSI (\x1b[...), OSC (\x1b]...\x07 or \x1b]...\x1b\\), and 2-byte charset sequences (\x1b(B)
const RE_ANSI = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][A-Za-z0-9])/g;
const RE_HAS_ANSI_OR_CR = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][A-Za-z0-9])|\r(?!\n)/;

/** Returns true when `text` contains ANSI escape sequences or standalone `\r` overwrites. */
export function hasAnsiOrCr(text) {
  return typeof text === "string" && text.length > 0 && RE_HAS_ANSI_OR_CR.test(text);
}

function collapseLineCarriageReturns(body) {
  if (!body.includes("\r")) return body;
  const parts = body.split("\r");
  const last = parts[parts.length - 1];
  if (last !== "") return last;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] !== "") return parts[i];
  }
  return "";
}

/**
 * Strip ANSI SGR/CSI/OSC sequences and collapse `\r` progress frames to the
 * final overwrite per line. Normal text/code without ANSI or standalone `\r`
 * (including CRLF `\r\n`) is returned untouched.
 */
export function ansiClean(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  if (!hasAnsiOrCr(input)) return input;

  const lines = input.split("\n");
  const lastIdx = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Preserve CRLF (\r\n): a trailing \r immediately before \n is a line ending, not a CR overwrite.
    const hasCrlf = i < lastIdx && raw.endsWith("\r");
    const body = hasCrlf ? raw.slice(0, -1) : raw;
    const collapsed = collapseLineCarriageReturns(body);
    const cleaned = collapsed.replace(RE_ANSI, "");
    lines[i] = hasCrlf ? `${cleaned}\r` : cleaned;
  }

  return lines.join("\n");
}

ansiClean.filterName = FILTERS.ANSI_CLEAN;
