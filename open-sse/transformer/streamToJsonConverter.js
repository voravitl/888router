/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;
  const dataStr0 = dataMatch[1].trim();
  if (dataStr0 === "[DONE]") return;

  // Some Responses servers (e.g. opencode Go) emit data-only SSE without
  // `event:` lines. Fall back to the payload's own `type` field so those
  // events are not silently dropped (empty output + status stuck at
  // in_progress).
  let eventType = eventMatch?.[1]?.trim() || "";
  const dataStr = dataStr0;
  if (!eventType) {
    let probe;
    try { probe = JSON.parse(dataStr); }
    catch { return; }
    if (typeof probe?.type !== "string") return;
    eventType = probe.type;
  }

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  if (parsed.response && typeof parsed.response === "object") {
    state.response = { ...state.response, ...parsed.response };
    state.created = parsed.response.created_at ?? state.created;
    if (parsed.response.usage) state.usage = structuredClone(parsed.response.usage);
    if (Array.isArray(parsed.response.output)) {
      parsed.response.output.forEach((item, index) => state.items.set(index, item));
    }
  }

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
  } else if (eventType === "response.failed") {
    state.status = "failed";
  } else if (eventType === "response.incomplete") {
    state.status = "incomplete";
  }
}

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [] };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    response: {},
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: null,
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    buffer += decoder.decode();
    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    ...state.response,
    id: state.response.id || state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    ...(state.usage !== null && { usage: state.usage })
  };
}
