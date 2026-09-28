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

/**
 * Extract visible text from a Responses-API message item or text part array.
 * Used as a fallback when an upstream sends terminal events
 * (response.output_text.done / response.output_item.done) WITHOUT preceding
 * per-token response.output_text.delta events (compact streams) — without
 * this the client sees an empty stream.
 */
export function extractResponsesMessageText(item) {
  const content = item?.content ?? item;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const outputText = content.find((c) => c?.type === "output_text");
  if (typeof outputText?.text === "string" && outputText.text.length > 0) return outputText.text;
  return content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("");
}
