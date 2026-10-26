/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId, accumulateToolName } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { extractResponsesMessageText, extractResponsesMessageRefusal } from "../concerns/message.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }
  
  if (!chunk.choices?.length) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details)
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle a refusal. The Responses API has native refusal events
  // (`response.refusal.delta` / `.done`) and a `refusal` content part, so the
  // refusal is NOT smuggled in as text — a client that checks the part type
  // must still see a refusal.
  if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
    emitRefusalContent(state, emit, idx, delta.refusal);
  }

  // Handle tool_calls (empty array is truthy; require a real call)
  if (delta.tool_calls && delta.tool_calls.length) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    sendCompleted(state, emit);
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = idx;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: state.reasoningId, type: RESPONSES_ITEM.REASONING, summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: idx,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: {
        id: state.reasoningId,
        type: RESPONSES_ITEM.REASONING,
        summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }]
      }
    });
  }
}

/**
 * Emit a refusal as a native Responses-API refusal content part.
 *
 * The Responses API models a refusal as its own content part
 * (`{ type: "refusal", refusal }`) streamed via `response.refusal.delta` /
 * `response.refusal.done`. Emitting it as output_text would hide the refusal
 * from clients that switch on the part type.
 */
function emitRefusalContent(state, emit, idx, refusal) {
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${idx}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    // Remember the part type: the closing events must describe the SAME part
    // that was opened, and a refusal part closes as a refusal — not as
    // output_text.
    state.msgPartType[idx] = RESPONSES_ITEM.REFUSAL;

    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: idx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.REFUSAL, refusal: "" }
    });
  }

  emit("response.refusal.delta", {
    type: "response.refusal.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: idx,
    content_index: 0,
    delta: refusal
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += refusal;
}

function emitTextContent(state, emit, idx, content) {
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    const msgId = `msg_${state.responseId}_${idx}`;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: idx,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    state.msgPartType[idx] = RESPONSES_ITEM.OUTPUT_TEXT;

    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: idx,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: idx,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;
    // A refusal part closes as a refusal: `response.refusal.done` plus a
    // `content_part.done` carrying the refusal part. Closing it as
    // output_text would tell the client the refusal was normal answer text.
    const isRefusal = state.msgPartType?.[idx] === RESPONSES_ITEM.REFUSAL;

    if (isRefusal) {
      emit("response.refusal.done", {
        type: "response.refusal.done",
        item_id: msgId,
        output_index: parseInt(idx),
        content_index: 0,
        refusal: fullText
      });

      emit("response.content_part.done", {
        type: "response.content_part.done",
        item_id: msgId,
        output_index: parseInt(idx),
        content_index: 0,
        part: { type: RESPONSES_ITEM.REFUSAL, refusal: fullText }
      });

      emit("response.output_item.done", {
        type: "response.output_item.done",
        output_index: parseInt(idx),
        item: {
          id: msgId,
          type: RESPONSES_ITEM.MESSAGE,
          content: [{ type: RESPONSES_ITEM.REFUSAL, refusal: fullText }],
          role: ROLE.ASSISTANT
        }
      });
      return;
    }

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: parseInt(idx),
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: parseInt(idx),
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: parseInt(idx),
      item: {
        id: msgId,
        type: RESPONSES_ITEM.MESSAGE,
        content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }],
        role: ROLE.ASSISTANT
      }
    });
  }
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  // Accumulate the name across chunks, tolerating split ("Re"+"ad"), full
  // re-echo ("Read"+"Read"), and growing-snapshot ("Re"+"Read") stream shapes.
  // output_item.done reads this buffer, so the final item always carries the
  // complete, un-doubled name even when it streams in fragments.
  if (funcName) state.funcNames[tcIdx] = accumulateToolName(state.funcNames[tcIdx], funcName);

  if (!state.funcCallIds[tcIdx] && newCallId) {
    state.funcCallIds[tcIdx] = newCallId;
    
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: tcIdx,
      item: {
        id: `fc_${newCallId}`,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: "",
        call_id: newCallId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (refCallId) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: tcIdx,
        delta: tc.function.arguments
      });
    }
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";
    
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      output_index: parseInt(idx),
      arguments: args
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: parseInt(idx),
      item: {
        id: `fc_${callId}`,
        type: RESPONSES_ITEM.FUNCTION_CALL,
        arguments: args,
        call_id: callId,
        name: state.funcNames[idx] || ""
      }
    });

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null
      }
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// Responses identities and Chat tool indices are separate namespaces.
function responsesTool(state, data, item = {}) {
  state.responsesTools ||= [];
  const itemId = item.id ?? data.item_id;
  const callId = item.call_id ?? data.call_id;
  const outputIndex = data.output_index;
  let tool = state.responsesTools.find(t => itemId && t.itemId === itemId)
    || state.responsesTools.find(t => callId && t.callId === callId)
    || state.responsesTools.find(t => outputIndex != null && t.outputIndex === outputIndex
      && (!itemId || !t.itemId || itemId === t.itemId)
      && (!callId || !t.callId || callId === t.callId));
  if (!tool) {
    // Legacy single-call streams omit routing metadata. Only infer identity
    // when exactly one call exists; parallel streams must identify their call.
    if (!itemId && !callId && outputIndex == null) {
      return state.responsesTools.length === 1 ? state.responsesTools[0] : null;
    }
    tool = { index: state.responsesTools.length, args: "", started: false, terminal: false };
    state.responsesTools.push(tool);
  }
  tool.itemId ??= itemId;
  tool.callId ??= callId;
  tool.outputIndex ??= outputIndex;
  tool.name ||= item.name ?? data.name ?? "";
  tool.id ||= callId || fallbackToolCallId();
  return tool;
}

function responsesToolDelta(tool, value, terminal = false) {
  if (!tool) return null;
  let args = "";
  if (!tool.terminal && typeof value === "string") {
    if (terminal) {
      // Chat is append-only: a conflicting terminal value cannot retract an
      // emitted prefix. Keep the delivered prefix rather than concatenate two
      // incompatible JSON documents. A matching full value emits only its tail.
      if (value.startsWith(tool.args)) args = value.slice(tool.args.length);
      tool.terminal = true;
    } else {
      args = value;
    }
    tool.args += args;
  }
  if (!tool.started) {
    tool.started = true;
    return { index: tool.index, id: tool.id, type: OPENAI_BLOCK.FUNCTION,
      function: { name: tool.name, arguments: args } };
  }
  if (!args) return null;
  return { index: tool.index, function: { arguments: args } };
}

function isResponsesTool(item) {
  return item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === "custom_tool_call";
}

function responsesToolValue(item) {
  return item?.type === "custom_tool_call" ? item.input : item?.arguments;
}

// A call at index zero also finishes as tool_calls.
function computeFinishReason(state) {
  return state.responsesTools?.length > 0 || state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    state.respTextDeltaIdx = state.respTextDeltaIdx || {};
    state.respTextDeltaIdx[data.output_index ?? 0] = true;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: delta }
    );
  }

  // Text content done — compact streams may carry the FULL text here with NO
  // preceding per-token deltas. Emit it only when no delta was seen for this
  // output index, otherwise the client would get the text twice.
  if (eventType === "response.output_text.done") {
    const idx = data.output_index ?? 0;
    if (state.respTextDeltaIdx?.[idx]) return null;
    const text = typeof data.text === "string" && data.text.length > 0
      ? data.text
      : extractResponsesMessageText(data.part);
    if (!text) return null;
    state.respTextDeltaIdx = state.respTextDeltaIdx || {};
    state.respTextDeltaIdx[idx] = true;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: text }
    );
  }

  // Message item done — same compact-stream fallback at item granularity.
  if (eventType === "response.output_item.done" && data.item?.type === RESPONSES_ITEM.MESSAGE) {
    const idx = data.output_index ?? 0;
    const refusal = extractResponsesMessageRefusal(data.item);
    if (refusal && !state.respRefusalSeen?.[idx]) {
      state.respRefusalSeen = state.respRefusalSeen || {};
      state.respRefusalSeen[idx] = true;
      return buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        { refusal }
      );
    }
    if (state.respTextDeltaIdx?.[idx]) return null;
    const text = extractResponsesMessageText(data.item);
    if (!text) return null;
    state.respTextDeltaIdx = state.respTextDeltaIdx || {};
    state.respTextDeltaIdx[idx] = true;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: text }
    );
  }

  // Refusal delta — the model refused ("I can't help with that"). The OpenAI
  // chat shape has a first-class `delta.refusal` field, so it is carried
  // there instead of being dropped.
  if (eventType === "response.refusal.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    state.respRefusalSeen = state.respRefusalSeen || {};
    state.respRefusalSeen[data.output_index ?? 0] = true;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { refusal: delta }
    );
  }

  // Refusal done — a compact stream may carry the FULL refusal with NO
  // preceding delta. Emit it only when no delta was seen for this output
  // index, otherwise the client would get the refusal twice.
  if (eventType === "response.refusal.done") {
    const idx = data.output_index ?? 0;
    if (state.respRefusalSeen?.[idx]) return null;
    const refusal = typeof data.refusal === "string" && data.refusal.length > 0
      ? data.refusal
      : extractResponsesMessageRefusal(data.part);
    if (!refusal) return null;
    state.respRefusalSeen = state.respRefusalSeen || {};
    state.respRefusalSeen[idx] = true;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { refusal }
    );
  }

  // Resolve each event by its own identity, never by the last active call.
  const toolItemEvent = (eventType === "response.output_item.added"
    || eventType === "response.output_item.done") && isResponsesTool(data.item);
  const toolDeltaEvent = eventType === "response.function_call_arguments.delta"
    || eventType === "response.custom_tool_call_input.delta";
  const toolDoneEvent = eventType === "response.function_call_arguments.done"
    || eventType === "response.custom_tool_call_input.done";
  if (toolItemEvent || toolDeltaEvent || toolDoneEvent) {
    if (state.finishReasonSent) return null;
    const tool = responsesTool(state, data, data.item);
    const terminal = toolDoneEvent || eventType === "response.output_item.done";
    const value = toolItemEvent ? (terminal ? responsesToolValue(data.item) : undefined)
      : toolDoneEvent ? (eventType === "response.custom_tool_call_input.done" ? data.input : data.arguments)
      : data.delta;
    const delta = responsesToolDelta(tool, value, terminal);
    return delta ? buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [delta] }
    ) : null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    if (state.finishReasonSent) return null;
    // Direct callers expect ONE chunk. Recover all calls in its delta before
    // the finish marker, rather than returning an unsupported chunk array.
    const recoveredTools = [];
    for (const [output_index, item] of (data.response?.output || []).entries()) {
      if (!isResponsesTool(item)) continue;
      const delta = responsesToolDelta(responsesTool(state, { output_index }, item), responsesToolValue(item), true);
      if (delta) recoveredTools.push(delta);
    }
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
      
      state.usage = buildUsage({ promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: cacheReadTokens });
    }
    
    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js
      
      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        recoveredTools.length ? { tool_calls: recoveredTools } : {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }
      
      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return buildChunk(
        { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
        { content: `[Error] ${error.message || JSON.stringify(error)}` },
        OPENAI_FINISH.STOP
      );
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      reasoningDelta(delta)
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
