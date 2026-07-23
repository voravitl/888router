import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
// otherwise the array is returned as-is. Matches existing translator behavior.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const isTextOnly = parts.every(p => p.type === OPENAI_BLOCK.TEXT);
  if (isTextOnly) {
    return parts.map(p => p.text || "").join("\n");
  }
  return parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT ? parts[0].text : parts;
}
