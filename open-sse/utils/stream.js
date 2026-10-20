import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, normalizeWholeCompletionChunk } from "./streamHelpers.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure, stripResponsesLifecycleEcho } from "./responsesStreamHelpers.js";
import { restoreOpencodeToolNames } from "./opencodeToolSanitizer.js";
import { extractResponsesMessageText } from "../translator/concerns/message.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  let buffer = "";
  let usage = null;

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE ? { ...initState(sourceFormat), provider, toolNameMap, model } : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  // Tool-call accumulator: null = none seen yet (avoid allocating an empty
  // array for plain text responses), [] = at least one tool delta was seen.
  // Mirrors the text/thinking pattern so requestDetails reflects the full
  // shape the client actually received — otherwise tool-only responses are
  // recorded as "[Empty streaming response]" and dashboards incorrectly show
  // them as failures.
  // Cap protects against abusive upstreams that emit a runaway index — the
  // record only needs enough entries for the dashboard summary, not the
  // full call list.
  const MAX_TRACKED_TOOL_CALLS = 64;
  const MAX_TOOL_MAP_ENTRIES = 128;
  let accumulatedToolCalls = null;
  // Map identifier (itemId or callId) -> canonical record { id, name }
  const toolAliasMap = new Map();
  // Compact-stream fallback accounting: closure-local (NOT on shared `state` —
  // the translator keeps its own emit guard on state, and sharing one flag
  // would let the accumulate-first ordering suppress the client chunk).
  const respTextDeltaSeen = {};

  function trackResponsesToolCall(itemId, callId, name) {
    if (accumulatedToolCalls === null) accumulatedToolCalls = [];

    const recByCall = callId ? toolAliasMap.get(callId) : null;
    const recByItem = itemId ? toolAliasMap.get(itemId) : null;

    if (recByCall && recByItem && recByCall !== recByItem) {
      // Late alias reconciliation: both aliases were tracked under separate records
      if (!recByCall.name && (recByItem.name || name)) recByCall.name = recByItem.name || name;
      const removeIdx = accumulatedToolCalls.indexOf(recByItem);
      if (removeIdx !== -1) accumulatedToolCalls.splice(removeIdx, 1);
      // Redirect all map aliases pointing to recByItem over to recByCall
      for (const [key, val] of toolAliasMap.entries()) {
        if (val === recByItem) {
          toolAliasMap.set(key, recByCall);
        }
      }
      return;
    }

    const canonical = recByCall || recByItem;
    if (canonical) {
      if (callId && canonical.id !== callId && canonical.id === itemId) {
        canonical.id = callId;
      }
      if (!canonical.name && name) canonical.name = name;
      if (itemId && toolAliasMap.size < MAX_TOOL_MAP_ENTRIES) toolAliasMap.set(itemId, canonical);
      if (callId && toolAliasMap.size < MAX_TOOL_MAP_ENTRIES) toolAliasMap.set(callId, canonical);
      return;
    }

    const preferredId = callId || itemId;
    if (!preferredId) return;

    if (accumulatedToolCalls.length < MAX_TRACKED_TOOL_CALLS) {
      const newRec = { id: preferredId, name: name || null };
      accumulatedToolCalls.push(newRec);
      if (itemId && toolAliasMap.size < MAX_TOOL_MAP_ENTRIES) toolAliasMap.set(itemId, newRec);
      if (callId && toolAliasMap.size < MAX_TOOL_MAP_ENTRIES) toolAliasMap.set(callId, newRec);
    }
  }

  // Shared OpenAI stream accounting for passthrough and the final buffered
  // line in flush(). Keeps the gateway's content/tool/usage totals in sync with
  // exactly what the client receives, including whole-completion frames that
  // normalizeWholeCompletionChunk() moved onto `delta`.
  function accumulateOpenAIChunk(parsed) {
    const delta = parsed?.choices?.[0]?.delta;
    const content = delta?.content;
    const reasoning = delta?.reasoning_content;
    if (content && typeof content === "string") {
      totalContentLength += content.length;
      accumulatedContent += content;
    }
    if (reasoning && typeof reasoning === "string") {
      totalContentLength += reasoning.length;
      accumulatedThinking += reasoning;
    }

    const toolCalls = delta?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      if (accumulatedToolCalls === null) accumulatedToolCalls = [];
      for (const tc of toolCalls) {
        if (accumulatedToolCalls.length >= MAX_TRACKED_TOOL_CALLS) break;
        const index = Number(tc.index ?? accumulatedToolCalls.length);
        const existing = accumulatedToolCalls.find((c) => c.index === index);
        if (existing) {
          if (tc.id && existing.id !== tc.id) existing.id = tc.id;
          if (tc.function?.name && !existing.name) existing.name = tc.function.name;
        } else {
          accumulatedToolCalls.push({
            id: tc.id || `tc_index_${index}`,
            name: tc.function?.name || null,
            index,
          });
        }
      }
    }

    // Legacy function_call deltas carry no index. Keep one record and fill in
    // the name when it arrives, otherwise a function-call-only turn is still
    // recorded as empty.
    const functionCall = delta?.function_call;
    if (functionCall && typeof functionCall === "object") {
      if (accumulatedToolCalls === null) accumulatedToolCalls = [];
      const existing = accumulatedToolCalls.find((c) => c.id === "legacy_function_call");
      if (existing) {
        if (functionCall.name && !existing.name) existing.name = functionCall.name;
      } else if (accumulatedToolCalls.length < MAX_TRACKED_TOOL_CALLS) {
        accumulatedToolCalls.push({
          id: "legacy_function_call",
          name: functionCall.name || null,
          index: 0,
        });
      }
    }

    const extracted = extractUsage(parsed);
    if (extracted) usage = mergeUsage(usage, extracted);
  }

  // Shared field repair for passthrough frames, used by both the streaming
  // loop and the final buffered line so flush() cannot emit a raw
  // whole-completion frame after transform() normalized it.
  function normalizePassthroughFields(parsed, normalized) {
    let fieldsInjected = normalized;
    const idFixed = fixInvalidId(parsed);

    if (parsed.choices !== undefined) {
      if (!parsed.object) {
        parsed.object = "chat.completion.chunk";
        fieldsInjected = true;
      } else if (parsed.object === "chat.completion") {
        // Whole-completion frames keep the non-stream object name; strict
        // OpenAI stream parsers expect the chunk variant.
        parsed.object = "chat.completion.chunk";
        fieldsInjected = true;
      }
      if (!parsed.created) {
        parsed.created = Math.floor(Date.now() / 1000);
        fieldsInjected = true;
      }
    }

    // Strip Azure-specific non-standard fields from streaming chunks.
    if (parsed.prompt_filter_results !== undefined) {
      delete parsed.prompt_filter_results;
      fieldsInjected = true;
    }
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice.content_filter_results !== undefined) {
          delete choice.content_filter_results;
          fieldsInjected = true;
        }
        // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
        // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
        // every streaming delta. @ai-sdk/openai-compatible checks
        // `delta.tool_calls != null` — an empty array passes this check,
        // causing premature `reasoning-end` on every chunk.
        if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
          delete choice.delta.tool_calls;
          fieldsInjected = true;
        }
      }
    }

    return { idFixed, fieldsInjected };
  }

  // Shared translate-mode accounting. Kept in one place so a final buffered
  // line without a newline contributes content/tool calls/usage exactly like a
  // line that passed through transform().
  function accumulateTranslateChunk(parsed) {
    // Claude format - content
    if (parsed.delta?.text) {
      totalContentLength += parsed.delta.text.length;
      accumulatedContent += parsed.delta.text;
    }
    // Claude format - thinking
    if (parsed.delta?.thinking) {
      totalContentLength += parsed.delta.thinking.length;
      accumulatedThinking += parsed.delta.thinking;
    }
    // Claude format - tool_use block. The id/name arrive on
    // content_block_start with type=tool_use; subsequent input_json_delta
    // deltas carry no id. A single start is enough to mark the response as
    // carrying a tool call.
    if (parsed.content_block?.type === "tool_use" && (accumulatedToolCalls?.length ?? 0) < MAX_TRACKED_TOOL_CALLS) {
      if (accumulatedToolCalls === null) accumulatedToolCalls = [];
      const id = parsed.content_block.id || `tool_${accumulatedToolCalls.length}`;
      if (!accumulatedToolCalls.some((c) => c.id === id)) {
        accumulatedToolCalls.push({ id, name: parsed.content_block.name || null });
      }
    }
    // OpenAI format - content
    if (parsed.choices?.[0]?.delta?.content) {
      totalContentLength += parsed.choices[0].delta.content.length;
      accumulatedContent += parsed.choices[0].delta.content;
    }
    // OpenAI format - reasoning
    if (parsed.choices?.[0]?.delta?.reasoning_content) {
      totalContentLength += parsed.choices[0].delta.reasoning_content.length;
      accumulatedThinking += parsed.choices[0].delta.reasoning_content;
    }
    // OpenAI format - tool_calls (streaming: each delta has a partial
    // tool_call with index). Dedup by index so subsequent argument-only
    // deltas for the same call don't create a second entry. When a
    // delta carries both id and index, store the id (it's the canonical
    // client-facing identifier); otherwise fall back to the index key.
    // Coerce index to Number — upstreams have been observed emitting
    // either string or integer, and strict equality would miss matches.
    const oaToolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls;
    if (Array.isArray(oaToolCallDeltas) && oaToolCallDeltas.length > 0) {
      if (accumulatedToolCalls === null) accumulatedToolCalls = [];
      for (const tc of oaToolCallDeltas) {
        if (accumulatedToolCalls.length >= MAX_TRACKED_TOOL_CALLS) break;
        const index = Number(tc.index ?? accumulatedToolCalls.length);
        const existing = accumulatedToolCalls.find((c) => c.index === index);
        if (existing) {
          if (tc.id && existing.id !== tc.id) existing.id = tc.id;
          if (tc.function?.name && !existing.name) existing.name = tc.function.name;
        } else {
          accumulatedToolCalls.push({
            id: tc.id || `tc_index_${index}`,
            name: tc.function?.name || null,
            index,
          });
        }
      }
    }
    // Legacy OpenAI function_call deltas carry no index. Keep one record
    // so a function-call-only turn is not recorded as empty.
    const oaFunctionCall = parsed.choices?.[0]?.delta?.function_call;
    if (oaFunctionCall && typeof oaFunctionCall === "object") {
      if (accumulatedToolCalls === null) accumulatedToolCalls = [];
      const existing = accumulatedToolCalls.find((c) => c.id === "legacy_function_call");
      if (existing) {
        if (oaFunctionCall.name && !existing.name) existing.name = oaFunctionCall.name;
      } else if (accumulatedToolCalls.length < MAX_TRACKED_TOOL_CALLS) {
        accumulatedToolCalls.push({
          id: "legacy_function_call",
          name: oaFunctionCall.name || null,
          index: 0,
        });
      }
    }

    // Gemini format
    if (parsed.candidates?.[0]?.content?.parts) {
      for (const part of parsed.candidates[0].content.parts) {
        if (part.text && typeof part.text === "string") {
          totalContentLength += part.text.length;
          // Check if this is thinking content
          if (part.thought === true) {
            accumulatedThinking += part.text;
          } else {
            accumulatedContent += part.text;
          }
        }
        // Gemini functionCall (single non-streaming response carries the
        // full call; mark it so the response isn't logged as empty).
        if (part.functionCall && part.functionCall.name) {
          if (accumulatedToolCalls === null) accumulatedToolCalls = [];
          if (accumulatedToolCalls.length < MAX_TRACKED_TOOL_CALLS) {
            accumulatedToolCalls.push({
              id: part.functionCall.id || `gemini_fc_${accumulatedToolCalls.length}`,
              name: part.functionCall.name,
            });
          }
        }
      }
    }

    // OpenAI Responses format - content
    if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
      totalContentLength += parsed.delta.length;
      accumulatedContent += parsed.delta;
      respTextDeltaSeen[parsed.output_index ?? 0] = true;
    }
    // Compact-stream fallback: terminal events carrying full text with NO
    // preceding deltas (mirrors the translator guard so server-side
    // accounting matches what the client receives).
    if (parsed.type === "response.output_text.done" && !respTextDeltaSeen[parsed.output_index ?? 0]) {
      const doneText = typeof parsed.text === "string" && parsed.text.length > 0
        ? parsed.text
        : extractResponsesMessageText(parsed.part);
      if (doneText) {
        totalContentLength += doneText.length;
        accumulatedContent += doneText;
        respTextDeltaSeen[parsed.output_index ?? 0] = true;
      }
    }
    if (parsed.type === "response.output_item.done" && parsed.item?.type === "message" && !respTextDeltaSeen[parsed.output_index ?? 0]) {
      const itemText = extractResponsesMessageText(parsed.item);
      if (itemText) {
        totalContentLength += itemText.length;
        accumulatedContent += itemText;
        respTextDeltaSeen[parsed.output_index ?? 0] = true;
      }
    }
    // OpenAI Responses format - reasoning
    if (parsed.type === "response.reasoning_summary_text.delta" && typeof parsed.delta === "string") {
      totalContentLength += parsed.delta.length;
      accumulatedThinking += parsed.delta;
    }
    // OpenAI Responses format - tool_calls
    if (parsed.type === "response.output_item.added" && (parsed.item?.type === "function_call" || parsed.item?.type === "custom_tool_call")) {
      const itemId = parsed.item.id || parsed.item_id || null;
      const callId = parsed.item.call_id || null;
      const name = parsed.item.name || null;
      trackResponsesToolCall(itemId, callId, name);
    }
    if (parsed.type === "response.output_item.done" && (parsed.item?.type === "function_call" || parsed.item?.type === "custom_tool_call")) {
      const itemId = parsed.item.id || parsed.item_id || null;
      const callId = parsed.item.call_id || null;
      const name = parsed.item.name || null;
      trackResponsesToolCall(itemId, callId, name);
    }
    if (parsed.type === "response.function_call_arguments.delta" || parsed.type === "response.custom_tool_call_input.delta") {
      const itemId = parsed.item_id || parsed.id || null;
      const callId = parsed.call_id || null;
      trackResponsesToolCall(itemId, callId, null);
    }

    // Extract usage
    const extracted = extractUsage(parsed);
    if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging
  }

  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  // True when the last passthrough line was not followed by a blank line, so
  // flush must close the SSE frame before appending a synthesized [DONE].
  let passthroughFrameOpen = false;

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          const isDoneSentinel = trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]";
          if (isDoneSentinel) streamDoneSent = true;

          if (trimmed.startsWith("data:") && !isDoneSentinel) {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());

              // Some upstreams deliver a whole completion in
              // `choices[].message` even on a streaming request. Normalize it
              // to `choices[].delta` before the valuable-content gate so the
              // client and the stream accumulator both see the answer.
              const normalized = normalizeWholeCompletionChunk(parsed);
              const { idFixed, fieldsInjected } = normalizePassthroughFields(parsed, normalized);

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              accumulateOpenAIChunk(parsed);

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          if (trimmed === "") {
            passthroughFrameOpen = false;
          } else {
            if (isDoneSentinel && passthroughFrameOpen) {
              // The upstream omitted the blank line before [DONE]; close the
              // previous event so the sentinel is not merged into its payload.
              output = "\n" + output;
            }
            passthroughFrameOpen = true;
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;

        // A whole-completion frame on an OpenAI-format upstream must become a
        // delta before the translator runs, otherwise a Claude/Gemini client
        // sees the same empty stream the passthrough path used to produce.
        if (targetFormat === FORMATS.OPENAI) {
          normalizeWholeCompletionChunk(parsed);
        }

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if (keepsOpenAIResponsesFormat && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          continue;
        }

        accumulateTranslateChunk(parsed);

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          stripResponsesLifecycleEcho(parsed);
          const chunkData = state?.toolNameMap?.size > 0 ? restoreOpencodeToolNames(parsed, state.toolNameMap) : parsed;
          const output = formatSSE({ event: openAIResponsesEventName, data: chunkData }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          continue;
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }
      }
    },

    flush(controller) {
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            const residual = buffer.trim();
            const isDataLine = residual.startsWith("data:");
            const isDoneLine = isDataLine && residual.slice(5).trim() === "[DONE]";

            if (isDoneLine) {
              streamDoneSent = true;
            } else if (isDataLine) {
              try {
                const parsed = JSON.parse(residual.slice(5).trim());
                const normalized = normalizeWholeCompletionChunk(parsed);
                const { idFixed, fieldsInjected } = normalizePassthroughFields(parsed, normalized);
                // The final line can carry content/usage that never passed
                // through transform() when the upstream omitted the trailing
                // newline; account for it here too.
                accumulateOpenAIChunk(parsed);

                // Mirror transform()'s finish-chunk usage injection: a final
                // finish line without usage must not reach the client bare.
                const isFinishChunk = parsed.choices?.[0]?.finish_reason;
                let usageInjected = false;
                if (isFinishChunk) {
                  if (!hasValidUsage(parsed.usage)) {
                    const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                    parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                    usage = estimated;
                  } else if (usage) {
                    const buffered = addBufferToUsage(usage);
                    parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                  }
                  usageInjected = true;
                }

                output = (normalized || idFixed || fieldsInjected || usageInjected)
                  ? `data: ${JSON.stringify(parsed)}`
                  : (buffer.startsWith("data:") && !buffer.startsWith("data: ") ? "data: " + buffer.slice(5) : buffer);
              } catch {
                // Keep the raw residual when it is not valid JSON.
              }
            }

            if (passthroughFrameOpen && residual) {
              // A previous complete line left its event open (the upstream
              // ended with a single newline). Close it before the residual so
              // the two payloads cannot become one SSE event.
              output = "\n" + output;
              passthroughFrameOpen = false;
            }

            if (isDataLine) {
              // A residual data line has no following blank line in the
              // upstream buffer. Terminate the SSE frame explicitly, otherwise
              // the later `data: [DONE]` is concatenated into the same event.
              if (!output.endsWith("\n")) output += "\n\n";
              else if (!output.endsWith("\n\n")) output += "\n";
              passthroughFrameOpen = false;
            } else {
              if (!output.endsWith("\n")) output += "\n";
              if (residual) passthroughFrameOpen = true;
            }

            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          // A stream that ends right after a single newline leaves the last
          // event open: the transform consumed that newline as the line
          // separator and never saw the blank line. Close it before the
          // synthesized [DONE], otherwise both payloads become one SSE event.
          if (passthroughFrameOpen) {
            const frameEnd = "\n";
            reqLogger?.appendConvertedChunk?.(frameEnd);
            controller.enqueue(sharedEncoder.encode(frameEnd));
            passthroughFrameOpen = false;
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking,
              toolCalls: accumulatedToolCalls
            }, usage, ttftAt);
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          if (parsed && !parsed.done) {
            if (targetFormat === FORMATS.OPENAI) {
              normalizeWholeCompletionChunk(parsed);
            }
            // The final line did not pass through transform(); account for it
            // before translating so content/tool calls/usage are not lost.
            accumulateTranslateChunk(parsed);
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking,
            toolCalls: accumulatedToolCalls
          }, state?.usage, ttftAt);
        }
      } catch (error) {
        console.log("Error in flush:", error);
      } finally {
        toolAliasMap.clear();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

/** Observe Claude SSE for accounting while forwarding every upstream byte unchanged. */
export function createClaudeNativeStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let lineBuffer = "";
  let dataLines = [];
  let usage = null;
  let ttftAt = null;
  let contentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let accumulatedToolCalls = null;
  let completed = false;
  let eventChars = 0;
  let eventLines = 0;
  let discardEvent = false;
  let discardLine = false;
  const MAX_EVENT_CHARS = 1024 * 1024;
  const MAX_EVENT_LINES = 2048;
  const MAX_LINE_CHARS = 64 * 1024;
  const MAX_CAPTURE_CHARS = 256 * 1024;
  const MAX_TOOL_CALLS = 64;

  const processEvent = () => {
    if (!discardEvent && dataLines.length > 0) {
      try {
        const parsed = JSON.parse(dataLines.join("\n"));
        if (parsed?.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          accumulatedToolCalls ||= [];
          const { id, name } = parsed.content_block;
          if (accumulatedToolCalls.length < MAX_TOOL_CALLS && !accumulatedToolCalls.some((tool) => tool.id === id)) {
            accumulatedToolCalls.push({ id: id || `tool_${accumulatedToolCalls.length}`, name: name || null });
          }
        }
        const delta = parsed?.delta;
        if (typeof delta?.text === "string") {
          contentLength += delta.text.length;
          if (accumulatedContent.length < MAX_CAPTURE_CHARS) accumulatedContent += delta.text.slice(0, MAX_CAPTURE_CHARS - accumulatedContent.length);
        }
        if (typeof delta?.thinking === "string") {
          contentLength += delta.thinking.length;
          if (accumulatedThinking.length < MAX_CAPTURE_CHARS) accumulatedThinking += delta.thinking.slice(0, MAX_CAPTURE_CHARS - accumulatedThinking.length);
        }
        const extracted = extractUsage(parsed);
        if (extracted) usage = mergeUsage(usage, extracted);
      } catch {
        // Unknown or non-JSON Claude events remain opaque to the observer.
      }
    }
    dataLines = [];
    eventChars = 0;
    eventLines = 0;
    discardEvent = false;
  };

  const observe = (text, final = false) => {
    if (discardLine) {
      const newlineAt = text.indexOf("\n");
      if (newlineAt === -1) return;
      discardLine = false;
      text = text.slice(newlineAt + 1);
    }
    lineBuffer += text;
    if (lineBuffer.length > MAX_LINE_CHARS && !lineBuffer.includes("\n")) {
      lineBuffer = "";
      dataLines = [];
      discardEvent = true;
      discardLine = true;
      return;
    }
    const lines = lineBuffer.split("\n");
    const trailingLine = final ? null : (lines.pop() || "");
    lineBuffer = trailingLine || "";
    for (let line of lines) {
      if (discardLine) discardLine = false;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") processEvent();
      else {
        eventLines++;
        eventChars += line.length + 1;
        if (line.length > MAX_LINE_CHARS || eventChars > MAX_EVENT_CHARS || eventLines > MAX_EVENT_LINES) {
          discardEvent = true;
          dataLines = [];
          continue;
        }
      }
      if (line !== "" && line.startsWith("data:") && !discardEvent) {
        const value = line.slice(5);
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    if (final) processEvent();
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (ttftAt === null) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      reqLogger?.appendProviderChunk?.(text);
      controller.enqueue(chunk);
      observe(text);
    },
    flush() {
      observe(decoder.decode(), true);
      if (completed) return;
      completed = true;
      trackPendingRequest(model, provider, connectionId, false);
      if (!hasValidUsage(usage) && contentLength > 0) usage = estimateUsage(body, contentLength, FORMATS.CLAUDE);
      if (hasValidUsage(usage)) logUsage(provider, usage, model, connectionId, apiKey);
      else appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => {});
      onStreamComplete?.({ content: accumulatedContent, thinking: accumulatedThinking, toolCalls: accumulatedToolCalls }, usage, ttftAt);
    }
  });
}
