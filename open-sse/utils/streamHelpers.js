import { FORMATS } from "../translator/formats.js";

// Parse SSE data line
export function parseSSELine(line, format = null) {
  if (!line) return null;

  const trimmed = line.trim();

  // NDJSON format (Ollama/local raw JSON lines without "data:" prefix)
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      // Fall through if not valid JSON
    }
  }

  // Standard SSE format: "data: {...}"
  if (!trimmed.startsWith("data:")) return null;

  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { done: true };

  try {
    return JSON.parse(data);
  } catch (error) {
    if (data.length > 0 && data.length < 1000) {
      console.log(`[WARN] Failed to parse SSE line (${data.length} chars): ${data.substring(0, 100)}...`);
    }
    return null;
  }
}

// Check if chunk has valuable content (not empty)
export function hasValuableContent(chunk, format) {
  // OpenAI format
  if (format === FORMATS.OPENAI && chunk.choices?.[0]?.delta) {
    const delta = chunk.choices[0].delta;
    return delta.content && delta.content !== "" ||
           delta.reasoning_content && delta.reasoning_content !== "" ||
           delta.tool_calls && delta.tool_calls.length > 0 ||
           delta.function_call ||
           chunk.choices[0].finish_reason ||
           delta.role;
  }

  // Claude format
  if (format === FORMATS.CLAUDE) {
    const isContentBlockDelta = chunk.type === "content_block_delta";
    const hasText = chunk.delta?.text && chunk.delta.text !== "";
    const hasThinking = chunk.delta?.thinking && chunk.delta.thinking !== "";
    const hasInputJson = chunk.delta?.partial_json && chunk.delta.partial_json !== "";
    
    if (isContentBlockDelta && !hasText && !hasThinking && !hasInputJson) {
      return false;
    }
    return true;
  }

  return true; // Other formats: keep all chunks
}

function isTextContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.thought === true) return false;
  if (part.type === "thinking" || part.type === "reasoning") return false;
  return !part.type || part.type === "text" || part.type === "output_text";
}

function isReasoningContentPart(part) {
  if (!part || typeof part !== "object") return false;
  return part.type === "thinking" || part.type === "reasoning" || part.thought === true;
}

/**
 * Text carried by a whole-completion `message` object. Some OpenAI-compatible
 * upstreams answer a streaming request with the whole completion in
 * `choices[0].message` instead of a `delta`; the text can be a plain string or
 * an array of content parts.
 *
 * Only actual answer text counts. Thinking/reasoning parts are routed through
 * wholeCompletionReasoning() instead, so the guard and the normalizer agree on
 * what "empty" means.
 */
function wholeCompletionText(message) {
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
 * Reasoning carried by a whole-completion `message` object across the shapes
 * upstreams use: `reasoning_content`, `reasoning`, `reasoningContent`,
 * `reasoning_details`, or thinking/reasoning content parts.
 */
function wholeCompletionReasoning(message) {
  if (!message) return "";
  let out = "";
  const seen = new Set();
  const add = (value) => {
    if (typeof value === "string" && value && !seen.has(value)) {
      seen.add(value);
      out += value;
    }
  };

  for (const key of ["reasoning_content", "reasoningContent", "reasoning"]) add(message[key]);
  if (Array.isArray(message.reasoning_details)) {
    for (const detail of message.reasoning_details) {
      if (typeof detail === "string") add(detail);
      else if (detail && typeof detail.text === "string") add(detail.text);
      else if (detail && typeof detail.summary_text === "string") add(detail.summary_text);
      else if (detail && typeof detail.summary === "string") add(detail.summary);
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isReasoningContentPart(part)) continue;
      if (typeof part.text === "string") add(part.text);
      else if (typeof part.thinking === "string") add(part.thinking);
    }
  }
  return out;
}

/** Tool calls carried by a whole-completion `message`, in streaming-delta shape. */
function wholeCompletionToolCalls(message) {
  if (!message) return null;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls.map((call, index) => ({
      ...call,
      index: Number.isFinite(call?.index) ? call.index : index,
    }));
  }
  if (Array.isArray(message.content)) {
    const toolUses = message.content.filter((part) => part && part.type === "tool_use");
    if (toolUses.length > 0) {
      return toolUses.map((part, index) => ({
        index,
        id: part.id || `tool_${index}`,
        type: "function",
        function: {
          name: part.name || "",
          arguments: JSON.stringify(part.input ?? {}),
        },
      }));
    }
  }
  return null;
}

/**
 * Normalize a whole-completion SSE frame (`choices[].message`) into the
 * streaming shape (`choices[].delta`) that OpenAI-compatible clients and the
 * gateway's own stream accounting understand.
 *
 * Why: comboStreamGuard sees text in `message.content` and releases the stream,
 * but the passthrough accumulator and most OpenAI-compatible clients only read
 * `delta.content`. The client then receives a 200 with no usable text and
 * retries, while the gateway records the attempt as "empty".
 *
 * Mutates `chunk` in place and returns true when at least one choice was
 * normalized. No-op for frames without `choices[].message`.
 */
export function normalizeWholeCompletionChunk(chunk) {
  if (!chunk || !Array.isArray(chunk.choices)) return false;
  let normalized = false;
  for (const choice of chunk.choices) {
    const message = choice && choice.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;

    const existingDelta = choice.delta && typeof choice.delta === "object" && !Array.isArray(choice.delta)
      ? choice.delta
      : null;
    const text = wholeCompletionText(message);
    const reasoning = wholeCompletionReasoning(message);
    const toolCalls = wholeCompletionToolCalls(message);
    const canMove = Boolean(text || reasoning || toolCalls || message.function_call || message.role);
    // An all-empty message (e.g. a usage-only frame) must stay untouched so
    // hasValuableContent() still forwards it.
    if (!existingDelta && !canMove) continue;

    const delta = existingDelta || (choice.delta = {});
    // An empty tool_calls array is treated as absent (the passthrough branch
    // strips it below because some clients misread it as a finished call).
    const deltaToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
      ? delta.tool_calls
      : null;
    // Track whether the delta carries something the client can use.
    let hasStreamField = Boolean(
      delta.content ||
      delta.reasoning_content ||
      deltaToolCalls ||
      delta.function_call ||
      delta.role
    );

    if (text && !delta.content) {
      delta.content = text;
      hasStreamField = true;
    }
    if (reasoning && !delta.reasoning_content) {
      delta.reasoning_content = reasoning;
      hasStreamField = true;
    }
    if (toolCalls && !deltaToolCalls) {
      delta.tool_calls = toolCalls;
      hasStreamField = true;
    }
    if (message.function_call && !delta.function_call) {
      delta.function_call = message.function_call;
      hasStreamField = true;
    }
    if (message.role && !delta.role) {
      delta.role = message.role;
      hasStreamField = true;
    }

    // Keep only the streaming shape once it carries data, so clients that read
    // both shapes do not render the answer twice.
    if (hasStreamField) {
      delete choice.message;
      normalized = true;
    }
  }
  return normalized;
}

// Fix invalid id (generic or too short)
export function fixInvalidId(parsed) {
  if (parsed.id && (parsed.id === "chat" || parsed.id === "completion" || parsed.id.length < 8)) {
    const fallbackId = parsed.extend_fields?.requestId || 
                      parsed.extend_fields?.traceId || 
                      Date.now().toString(36);
    parsed.id = `chatcmpl-${fallbackId}`;
    return true;
  }
  return false;
}

function cleanUsagePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  let cleaned = payload;

  if ("usage" in cleaned) {
    if (cleaned.usage === null) {
      const { usage, ...payloadWithoutUsage } = cleaned;
      cleaned = payloadWithoutUsage;
    } else if (typeof cleaned.usage === "object" && cleaned.usage.perf_metrics === null) {
      const { perf_metrics, ...usageWithoutPerf } = cleaned.usage;
      cleaned = { ...cleaned, usage: usageWithoutPerf };
    }
  }

  if (cleaned.response && typeof cleaned.response === "object" && !Array.isArray(cleaned.response)) {
    const cleanedResponse = cleanUsagePayload(cleaned.response);
    if (cleanedResponse !== cleaned.response) {
      cleaned = { ...cleaned, response: cleanedResponse };
    }
  }

  return cleaned;
}

// Format output as SSE
export function formatSSE(data, sourceFormat) {
  if (data === null || data === undefined) return "data: null\n\n";
  if (data && data.done) return "data: [DONE]\n\n";

  // OpenAI Responses API format
  if (data && data.event && data.data) {
    const cleanedEventData = cleanUsagePayload(data.data);
    return `event: ${data.event}\ndata: ${JSON.stringify(cleanedEventData)}\n\n`;
  }

  data = cleanUsagePayload(data);

  // Claude format
  if (sourceFormat === FORMATS.CLAUDE && data && data.type) {
    return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return `data: ${JSON.stringify(data)}\n\n`;
}
