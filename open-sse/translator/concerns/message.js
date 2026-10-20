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

/**
 * Extract the refusal from a Responses-API message item or text part array.
 *
 * The Responses API models a refusal as its own content part
 * (`{ type: "refusal", refusal }`), so it never shows up in the text parts —
 * reading only `part.text` silently dropped it and the client saw an empty
 * answer.
 */
export function extractResponsesMessageRefusal(item) {
  const content = item?.content ?? item;
  if (typeof content === "string") return "";
  // A single part object (the `part` of a response.refusal.done event).
  if (content && !Array.isArray(content) && typeof content === "object") {
    return content.type === "refusal" && typeof content.refusal === "string" ? content.refusal : "";
  }
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part?.type === "refusal" && typeof part.refusal === "string") out += part.refusal;
  }
  return out;
}
