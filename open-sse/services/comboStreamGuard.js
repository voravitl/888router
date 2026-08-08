/**
 * Combo stream guard — decides "has this stream produced real text?" BEFORE
 * the client sees a byte of it.
 *
 * Why: handleComboChat() treats any 2xx with a body as success. But reasoning
 * models (deepseek/ollama/kimi…) stream ONLY reasoning deltas and then end
 * with finish_reason "length" and zero text content. The client gets a 200
 * SSE stream with nothing usable — the "answer got cut off" bug.
 *
 * Non-stream (JSON) requests already defend this via isReasoningEmptyContent
 * in combo.js; the SSE path had no equivalent because the stream can't be
 * inspected after the head has already gone to the client. This guard buffers
 * the head of the stream JUST long enough to see text (or the terminal
 * finish event), then releases everything — so the verdict exists before the
 * first byte leaves the router. Latency cost: only up to the first content
 * chunk, identical to what the client would wait anyway.
 */
export function createComboStreamGuard() {
  /** Buffered bytes not yet forwarded to the client. */
  let buffer = [];
  let bufferBytes = 0;
  /** Once any real (non-empty) content delta is seen, forward instantly. */
  let sawText = false;
  /** Seen terminal event (finish_reason "[DONE]" / done). */
  let sawTerminal = false;
  /** Cap: reasoning preambles can be long; past this we assume live and release. */
  const MAX_BUFFER_BYTES = 256 * 1024;

  const parseChunk = (text) => {
    const lines = text.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") { sawTerminal = true; continue; }
      try {
        const json = JSON.parse(payload);
        if (json.done === true) sawTerminal = true;
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        const textVal =
          (delta && typeof delta.content === "string" && delta.content !== "" && delta.content) ||
          (delta && typeof delta.text === "string" && delta.text !== "" ? delta.text : "");
        if (textVal) sawText = true;
        if (json.choices && json.choices[0] && json.choices[0].finish_reason) {
          sawTerminal = true;
        }
      } catch { /* non-JSON / partial line — not meaningful for the guard */ }
    }
  };

  return {
    /** Feed one upstream chunk. */
    feed(value) {
      const sz = value?.byteLength || value?.length || 0;
      if (sz === 0) return { sawText, sawTerminal };
      parseChunk(new TextDecoder().decode(value));
      if (!sawText) {
        buffer.push(value);
        bufferBytes += sz;
        if (bufferBytes > MAX_BUFFER_BYTES) {
          // Safety release: assume live, drop the head.
          buffer = [];
          bufferBytes = 0;
          sawText = true;
        }
      }
      return { sawText, sawTerminal };
    },

    /** Enough bytes to decide: either text seen or terminal seen. */
    hasDecision() {
      return sawText || sawTerminal;
    },

    /** Concatenated bytes buffered so far (caller enqueues before forwarding). */
    release() {
      const out = buffer.length === 1 ? buffer[0] : Buffer.concat(buffer);
      buffer = [];
      bufferBytes = 0;
      return out;
    },

    /** True = stream ENDED (terminal seen) with zero text content. */
    isEmpty() {
      return !sawText && sawTerminal;
    },

    /** Explicit end-of-stream signal (reader done). */
    feedEnd() {
      sawTerminal = true;
      return { sawText, sawTerminal };
    },
  };
}