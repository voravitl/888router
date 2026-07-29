// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE, HARD_CAP_BYTES, FILTERS } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Gemini format: body.contents || body.request?.contents
  if (Array.isArray(body.contents) || Array.isArray(body.request?.contents)) {
    return compressGeminiFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

// Compress Gemini format: body.contents || body.request?.contents
function compressGeminiFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const contents = Array.isArray(body.contents) ? body.contents
      : Array.isArray(body.request?.contents) ? body.request.contents
      : [];

    for (const item of contents) {
      if (!item || !Array.isArray(item.parts)) continue;
      const role = String(item.role || "").toLowerCase();
      if (role === "function" || role === "tool" || role === "user") {
        for (const part of item.parts) {
          if (!part) continue;
          if (part.functionResponse) {
            const fnResp = part.functionResponse;
            if (!fnResp || fnResp.response == null) continue;

            if (typeof fnResp.response === "string") {
              fnResp.response = compressText(fnResp.response, stats, "gemini-function-response");
            } else if (typeof fnResp.response === "object") {
              // Deep traverse object string fields (e.g. output, result) without breaking object structure
              for (const key of Object.keys(fnResp.response)) {
                const val = fnResp.response[key];
                if (typeof val === "string") {
                  fnResp.response[key] = compressText(val, stats, `gemini-function-response-${key}`);
                }
              }
            }
          } else if (typeof part.text === "string" && (role === "function" || role === "tool")) {
            part.text = compressText(part.text, stats, "gemini-tool-part");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressGeminiFormat error:", e.message);
    return null;
  }
  return stats;
}

/**
 * Apply RTK Hard Cap truncation to text exceeding HARD_CAP_BYTES.
 * Guaranteed invariant: out.length <= capBytes && out.length < text.length && out.length > 0
 */
export function applyHardCap(text, capBytes = HARD_CAP_BYTES) {
  if (!text || text.length <= capBytes) return text;

  const markerText = `\n\n[... truncated by 888router RTK Hard Cap ...]\n\n`;
  if (capBytes <= markerText.length) {
    return text.slice(0, capBytes);
  }

  const budget = capBytes - markerText.length;
  const lines = text.split("\n");

  let result = "";
  if (lines.length <= 180) {
    const headLen = Math.floor(budget * 0.65);
    const tailLen = budget - headLen;
    const head = text.slice(0, headLen);
    const tail = text.slice(-tailLen);
    result = `${head}${markerText}${tail}`;
  } else {
    const headLines = lines.slice(0, 100).join("\n");
    const tailLines = lines.slice(-40).join("\n");
    const candidate = `${headLines}${markerText}${tailLines}`;
    if (candidate.length <= capBytes) {
      result = candidate;
    } else {
      const headLen = Math.floor(budget * 0.65);
      const tailLen = budget - headLen;
      result = `${text.slice(0, headLen)}${markerText}${text.slice(-tailLen)}`;
    }
  }

  // Strict invariant enforcement: ensure never longer than capBytes and shorter than text
  if (result.length > capBytes) {
    result = result.slice(0, capBytes);
  }
  return result.length < text.length ? result : text.slice(0, capBytes);
}

function compressText(text, stats, shape) {
  if (typeof text !== "string") return text;
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  // RAW_CAP bypass safety: if blob exceeds RAW_CAP, STILL force apply hard cap!
  if (bytesIn > RAW_CAP) {
    const capped = applyHardCap(text, HARD_CAP_BYTES);
    if (capped.length < bytesIn) {
      stats.bytesAfter += capped.length;
      stats.hits.push({ shape, filter: FILTERS.HARD_CAP, saved: bytesIn - capped.length });
      return capped;
    }
    stats.bytesAfter += bytesIn;
    return text;
  }

  if (bytesIn < MIN_COMPRESS_SIZE) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  let workingText = text;
  let filterName = null;

  const fn = autoDetectFilter(workingText);
  if (fn) {
    const out = safeApply(fn, workingText);
    if (out && out.length > 0 && out.length < workingText.length) {
      filterName = fn.filterName || fn.name;
      workingText = out;
    }
  }

  // RTK v2 Hard Cap Guard: if text is still larger than HARD_CAP_BYTES, truncate safely
  if (workingText.length > HARD_CAP_BYTES) {
    const capped = applyHardCap(workingText, HARD_CAP_BYTES);
    if (capped && capped.length < workingText.length) {
      filterName = filterName ? `${filterName}+${FILTERS.HARD_CAP}` : FILTERS.HARD_CAP;
      workingText = capped;
    }
  }

  // Safety: never return empty, never grow the input
  if (!workingText || workingText.length === 0 || workingText.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }

  stats.bytesAfter += workingText.length;
  stats.hits.push({ shape, filter: filterName || "rtk-compress", saved: bytesIn - workingText.length });
  return workingText;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
