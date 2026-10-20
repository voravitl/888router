/**
 * Shared classification of OpenAI content parts and whole-completion
 * `message` payloads.
 *
 * Why: the combo stream guard (decides "is this stream empty?") and the
 * whole-completion normalizer (moves `message` onto `delta`) must agree on
 * what counts as ANSWER TEXT versus REASONING. When they disagreed, a
 * thinking-only frame was blessed as text by one side and stripped of its
 * content by the other, and the client received a 200 with an empty body.
 *
 * This module is the single source of truth for that classification. Keep the
 * two callers in sync by changing it here, not in both places.
 */

/** Content-part types that carry answer text. */
const TEXT_PART_TYPES = new Set(["text", "output_text"]);

/** Content-part types that carry reasoning, never answer text. */
const REASONING_PART_TYPES = new Set(["thinking", "reasoning"]);

/** Content-part type that carries a refusal (OpenAI `ChatCompletionContentPartRefusal`). */
const REFUSAL_PART_TYPE = "refusal";

/** Message keys that are alternate representations of the same reasoning. */
const REASONING_ALIAS_KEYS = ["reasoning_content", "reasoningContent", "reasoning"];

/**
 * Whether a content part is answer text.
 * A part with no `type` is text (older shapes), unless it is flagged
 * `thought: true` (Gemini) or typed as thinking/reasoning.
 */
export function isTextContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.thought === true) return false;
  if (REASONING_PART_TYPES.has(part.type)) return false;
  return !part.type || TEXT_PART_TYPES.has(part.type);
}

/** Whether a content part carries reasoning rather than answer text. */
export function isReasoningContentPart(part) {
  if (!part || typeof part !== "object") return false;
  return REASONING_PART_TYPES.has(part.type) || part.thought === true;
}

/** Whether a content part carries a refusal rather than answer text. */
export function isRefusalContentPart(part) {
  if (!part || typeof part !== "object") return false;
  return part.type === REFUSAL_PART_TYPE;
}

/**
 * Refusal carried by a whole-completion `message`, across the two documented
 * OpenAI shapes:
 *   - `message.refusal` (string) — the field on ChatCompletionMessage
 *   - `message.content[]` part `{ type: "refusal", refusal }` — the
 *     ChatCompletionContentPartRefusal form
 *
 * A refusal is the model's ANSWER ("I can't help with that"), not an error and
 * not an empty stream. It must never be dropped.
 */
export function messageRefusalText(message) {
  if (!message || typeof message !== "object") return "";
  // The field and the content part are two representations of the SAME
  // refusal, so the field wins — otherwise a message carrying both would
  // yield the refusal text twice.
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    return message.refusal;
  }
  let out = "";
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRefusalContentPart(part)) continue;
      if (typeof part.refusal === "string") out += part.refusal;
    }
  }
  return out;
}

/**
 * Answer text carried by a whole-completion `message` object.
 * The text can be a plain string or an array of content parts.
 */
export function messageContentText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (typeof part === "string") out += part;
    else if (isTextContentPart(part) && typeof part.text === "string") out += part.text;
  }
  return out;
}

/**
 * Reasoning carried by a whole-completion `message` object, across the shapes
 * upstreams use: `reasoning_content` / `reasoning` / `reasoningContent`
 * (alternate names for the SAME value), `reasoning_details[]` and thinking /
 * reasoning content parts.
 *
 * The alias keys are deduplicated against each other (a provider may send the
 * same reasoning under two names), but fragments inside the arrays are kept as
 * they are — two identical thinking blocks are two fragments, not one.
 */
export function messageReasoningText(message) {
  if (!message) return "";

  let out = "";
  const seenAliases = new Set();
  for (const key of REASONING_ALIAS_KEYS) {
    const value = message[key];
    if (typeof value === "string" && value && !seenAliases.has(value)) {
      seenAliases.add(value);
      out += value;
    }
  }

  if (Array.isArray(message.reasoning_details)) {
    for (const detail of message.reasoning_details) {
      if (typeof detail === "string") out += detail;
      else if (detail && typeof detail.text === "string") out += detail.text;
      else if (detail && typeof detail.content === "string") out += detail.content;
      else if (detail && typeof detail.summary_text === "string") out += detail.summary_text;
      else if (detail && typeof detail.summary === "string") out += detail.summary;
    }
  }

  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isReasoningContentPart(part)) continue;
      if (typeof part.text === "string") out += part.text;
      else if (typeof part.thinking === "string") out += part.thinking;
    }
  }

  return out;
}
