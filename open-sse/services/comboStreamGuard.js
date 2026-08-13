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
 *
 * The parser keeps a `pending` residual across feed() calls so a `data:` line
 * split across two upstream chunks is still recognized (a split content delta
 * must not turn into a false "empty" verdict). NDJSON lines without a `data:`
 * prefix are parsed as raw JSON so the application/x-ndjson content type is
 * actually supported.
 */
export function createComboStreamGuard() {
  /** Raw chunk bytes buffered until the verdict. */
  let chunks = [];
  let bufferBytes = 0;
  /** Incomplete SSE/NDJSON line carried between feed() calls. */
  let pending = "";
  /** Once any real (non-empty) content delta is seen, forward instantly. */
  let sawText = false;
  /** Seen an explicit terminal marker (finish_reason / [DONE] / done). */
  let sawTerminal = false;
  /** Reader reached end-of-stream (may be a clean finish OR a mid-stream cut). */
  let sawEos = false;
  /**
   * Reasoning deltas seen during the stream (delta.reasoning_content non-empty
   * or Ollama response carrying only thinking). Distinct from sawText: a stream
   * can carry reasoning yet end with zero text — that is the
   * reasoning_budget_exhausted signature, which combo must RETRY, not drop as
   * a generic empty verdict.
   */
  let sawReasoning = false;
  /** Terminal finish_reason captured from the final chunk, if any. */
  let finishReason = null;
  /** Reasoning preambles can be long; past this we assume live and release. */
  const MAX_BUFFER_BYTES = 64 * 1024;
  let capWarned = false;
  const dec = new TextDecoder();

  const consume = (text) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      // SSE `data:` lines and bare NDJSON JSON lines both parse the same way.
      const payload = t.startsWith("data:") ? t.slice(5).trim() : t;
      if (payload === "[DONE]") { sawTerminal = true; continue; }
      try {
        const json = JSON.parse(payload);
        // Ollama NDJSON: {"response":"...","done":true,"done_reason":"..."}
        if (json.done === true) sawTerminal = true;
        // Anthropic SSE: {"type":"message_stop"} or {"type":"message_delta","delta":{"stop_reason":"end_turn"}}
        if (json.type === "message_stop") sawTerminal = true;
        if (json.delta && json.delta.stop_reason) {
          finishReason = String(json.delta.stop_reason);
          sawTerminal = true;
        }

        const ollamaText = typeof json.response === "string" ? json.response : "";
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        const deltaText = (delta && (delta.content || delta.text)) || "";
        // Anthropic SSE: delta.text or delta.partial_json inside content_block_delta
        const anthropicText = (json.delta && typeof json.delta.text === "string") ? json.delta.text
          : (json.delta && typeof json.delta.partial_json === "string") ? json.delta.partial_json
          : "";

        const textVal = ollamaText || deltaText || anthropicText;
        if (typeof textVal === "string" && textVal.length > 0) sawText = true;

        // Reasoning-only deltas: delta.reasoning_content (OpenAI/opencode SSE)
        // or Anthropic delta.thinking (Claude 3.7/Kiro thinking delta)
        const anthropicReasoning = (json.delta && typeof json.delta.thinking === "string") ? json.delta.thinking : "";
        const reasoningVal = (delta && (delta.reasoning_content || delta.reasoning || delta.reasoningContent)) || anthropicReasoning;
        if (typeof reasoningVal === "string" && reasoningVal.length > 0) sawReasoning = true;

        const fr = (json.choices && json.choices[0] && json.choices[0].finish_reason) || json.done_reason || (json.delta && json.delta.stop_reason) || null;
        if (fr) {
          finishReason = typeof fr === "string" ? fr : String(fr);
          sawTerminal = true;
        }
      } catch { /* incomplete / non-JSON line — not meaningful for the guard */ }
    }
  };

  return {
    /** Feed one upstream chunk. */
    feed(value) {
      const sz = value?.byteLength || value?.length || 0;
      if (sz === 0) return { sawText, sawTerminal };
      consume(dec.decode(value, { stream: true }));
      // Buffer the raw chunk regardless of whether it carried content: the
      // caller replays everything up to the decision point via release().
      chunks.push(value);
      bufferBytes += sz;
      if (bufferBytes > MAX_BUFFER_BYTES) {
        // ponytail: an extremely long reasoning preamble (no text within
        // MAX_BUFFER_BYTES) decides "live" — the head is released as-is and
        // the empty-detection is skipped for this model only. The alternative
        // (waiting for text with no cap) could stall a genuine long-thinking
        // response forever. Upgrade path: tee the stream to keep inspecting
        // while forwarding (needs a TransformStream tee, non-trivial).
        if (!capWarned) {
          console.warn("[combo] stream guard cap hit — releasing head without empty verdict (model may still reply)");
          capWarned = true;
        }
        // NOTE: do NOT set sawText here. The cap release is only a "don't
        // stall a long-thinking model" decision — if the stream ends with zero
        // real content anyway, isEmpty() must still classify it as empty
        // (otherwise the client gets a 200 SSE with nothing usable, surfaced
        // as "502 empty stream content" on retry loops).
      }
      return { sawText, sawTerminal };
    },

    /** Enough bytes to decide: text, explicit terminal, or end-of-stream. */
    hasDecision() {
      return sawText || sawTerminal || sawEos;
    },

    /** Whether reasoning deltas were seen during the stream head. */
    sawReasoning() {
      return sawReasoning;
    },

    /** Terminal finish_reason captured from the final chunk, or null. */
    finishReason() {
      return finishReason;
    },

    /** Concatenated bytes buffered so far (caller enqueues before forwarding). */
    release() {
      let out;
      if (chunks.length === 1) {
        out = chunks[0];
      } else {
        // Manual concat: reader.read() yields Uint8Array; Buffer.concat would
        // break outside Node (edge/worker runtimes).
        const total = chunks.reduce((n, c) => n + (c.byteLength || c.length || 0), 0);
        out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.byteLength || c.length; }
      }
      chunks = [];
      bufferBytes = 0;
      return out;
    },

    /** True = stream ENDED with zero text. Either an explicit terminal marker
     *  or a clean EOF counts — some providers close without a finish marker.
     *  A mid-stream network cut surfaces through read() rejection, which the
     *  caller handles via cancel(), not feedEnd(), so EOF here is a clean
     *  close by construction. A cap-hit stream that ends with no text is STILL
     *  empty: the cap release only means "don't stall a long-thinking model",
     *  never "bless an all-reasoning stream as a success". */
    isEmpty() {
      return !sawText && (sawTerminal || sawEos);
    },

    /** Reader reached end-of-stream (clean close). */
    feedEnd() {
      consume(dec.decode());
      if (pending.trim()) consume("\n"); // force the last partial line through
      sawEos = true;
      return { sawText, sawTerminal, sawEos };
    },
  };
}
