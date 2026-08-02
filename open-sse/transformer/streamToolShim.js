// Stateful SSE Stream State Machine (Layer 3)
// Intercepts streaming text chunks from non-tool models, parses delta text from SSE JSON payloads,
// buffers <tool_call> XML tags across chunk boundaries, and emits spec-compliant SSE tool_calls events.

import { parseUniversalToolCalls, getDeclaredToolNames } from "../translator/concerns/universalToolParser.js";
import { repairAndParseJson } from "../translator/concerns/jsonAutoRepair.js";

const MAX_BUFFER_SIZE = 64 * 1024; // 64KB safety cap against memory DoS

const TAG_PREFIXES = [
  "<tool_call>",
  "<tool_use>",
  "<function_call>",
  "</tool_call>",
  "</tool_use>",
  "</function_call>",
  "</｜｜DSML｜｜>",
  "</｜｜",
  "<｜｜DSML｜｜>",
  "<｜｜>"
];

const HAS_OPEN_TOOL_TAG = (text) => text.includes("<tool_call>") || text.includes("<tool_use>") || text.includes("<function_call>") || text.includes("<｜｜DSML｜｜>") || text.includes("<｜｜>");
const HAS_CLOSE_TOOL_TAG = (text) => text.includes("</tool_call>") || text.includes("</tool_use>") || text.includes("</function_call>") || text.includes("</｜｜DSML｜｜>") || text.includes("</｜｜>");

/**
 * Checks if the trailing characters of `text` match a partial prefix of any XML tool tag.
 */
function getPartialTagPrefixLength(text) {
  if (!text) return 0;
  for (const tag of TAG_PREFIXES) {
    for (let len = tag.length - 1; len >= 1; len--) {
      const prefix = tag.slice(0, len);
      if (text.endsWith(prefix)) {
        return len;
      }
    }
  }
  return 0;
}

/**
 * Inspects `text` for unclosed `<tool_call>`/`<tool_use>`/`<function_call>` tags or trailing tag prefixes.
 * Preserves unclosed tag portions in `remainingBuffer` so sequential stream chunks are not lost.
 */
function extractUnclosedBuffer(text) {
  if (!text) return { cleanText: "", remainingBuffer: "", inTag: false };

  const openIndices = [
    text.lastIndexOf("<tool_call>"),
    text.lastIndexOf("<tool_use>"),
    text.lastIndexOf("<function_call>"),
    text.lastIndexOf("<｜｜DSML｜｜>"),
    text.lastIndexOf("<｜｜>")
  ].filter(idx => idx !== -1);

  if (openIndices.length > 0) {
    const lastOpenCall = Math.max(...openIndices);
    const closeIndices = [
      text.lastIndexOf("</tool_call>"),
      text.lastIndexOf("</tool_use>"),
      text.lastIndexOf("</function_call>"),
      text.lastIndexOf("</｜｜DSML｜｜>"),
      text.lastIndexOf("</｜｜>"),
      text.lastIndexOf("</｜｜")
    ].filter(idx => idx !== -1);

    const lastCloseCall = closeIndices.length > 0 ? Math.max(...closeIndices) : -1;
    if (lastCloseCall < lastOpenCall) {
      return {
        cleanText: text.slice(0, lastOpenCall),
        remainingBuffer: text.slice(lastOpenCall),
        inTag: true
      };
    }
  }

  const holdLen = getPartialTagPrefixLength(text);
  if (holdLen > 0) {
    return {
      cleanText: text.slice(0, text.length - holdLen),
      remainingBuffer: text.slice(text.length - holdLen),
      inTag: false
    };
  }

  return { cleanText: text, remainingBuffer: "", inTag: false };
}

/**
 * Creates a TransformStream that inspects SSE streams for <tool_call> tags and transforms them to tool_calls SSE events.
 * Supports both OpenAI SSE format and Claude SSE format (content_block_start/delta).
 */
export function createStreamToolShimTransformStream(tools = [], clientFormat = "openai", log = null) {
  const declaredNames = getDeclaredToolNames(tools);
  let textBuffer = "";
  let sseLineBuffer = "";
  let pendingEventName = "";
  let pendingEmptyTextBlockIndex = -1;
  const droppedBlockIndices = new Set();
  let inToolTag = false;
  let toolCallCounter = 0;
  let sawMessageStop = false;
  let textBlockClosed = false;
  let nextBlockIndex = 0;      // monotonic high-water mark for block allocation
  let openBlockIndex = -1;    // currently open block from upstream (-1 = none)
  let hasEmittedToolCalls = false;

  function processLine(line, controller) {
    const trimmed = line.trim();

    if (trimmed.startsWith("event: ")) {
      pendingEventName = trimmed.slice(7).trim();
      return; // Hold event line until data line arrives
    }

    // Pass non-data lines directly when not buffering inside tool tag
    if (!trimmed.startsWith("data: ")) {
      if (!inToolTag && !hasEmittedToolCalls) {
        if (pendingEventName) {
          if (pendingEventName === "message_stop") sawMessageStop = true;
          controller.enqueue(new TextEncoder().encode(`event: ${pendingEventName}\n`));
          pendingEventName = "";
        }
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      }
      return;
    }

    const dataStr = trimmed.slice(6).trim();
    if (dataStr === "[DONE]") {
      // Hold [DONE] for flush if tool calls were emitted or tag is buffering
      if (!inToolTag && !hasEmittedToolCalls) {
        sawMessageStop = true;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
      pendingEventName = "";
      return;
    }

    try {
      const json = JSON.parse(dataStr);

      // Suppress upstream "stop" or "end_turn" finish_reason chunks if tool calls are present
      if (hasEmittedToolCalls || inToolTag) {
        if (json.choices?.[0]?.finish_reason === "stop") {
          pendingEventName = "";
          return;
        }
        if (json.type === "message_delta" && json.delta?.stop_reason) {
          pendingEventName = "";
          return;
        }
        if (json.type === "message_stop") {
          pendingEventName = "";
          return;
        }
      }

      if (json.type === "message_stop" && !inToolTag && !hasEmittedToolCalls) {
        sawMessageStop = true;
      }

      // Track upstream block lifecycle for monotonic index allocation
      if (json.type === "content_block_start" && json.index !== undefined) {
        openBlockIndex = json.index;
        nextBlockIndex = Math.max(nextBlockIndex, json.index + 1);
      }
      if (json.type === "content_block_stop" && json.index !== undefined) {
        if (json.index === openBlockIndex) openBlockIndex = -1;
        nextBlockIndex = Math.max(nextBlockIndex, json.index + 1);
      }
      
      // Extract delta text content across OpenAI or Claude SSE formats
      let deltaContent = "";
      let isTextDelta = false;

      if (json.choices?.[0]?.delta?.content !== undefined) {
        deltaContent = json.choices[0].delta.content || "";
        isTextDelta = true;
      } else if (json.type === "content_block_delta" && json.delta?.text) {
        deltaContent = json.delta.text;
        isTextDelta = true;
      } else if (typeof json.content === "string") {
        deltaContent = json.content;
        isTextDelta = true;
      }

      if (isTextDelta && deltaContent) {
        textBuffer += deltaContent;

        // Prevent memory DoS
        if (textBuffer.length > MAX_BUFFER_SIZE) {
          log?.warn?.("TOOLSHIM", `Stream buffer overflow (${textBuffer.length} bytes), flushing text`);
          emitTextChunk(textBuffer, json, clientFormat, controller);
          textBuffer = "";
          inToolTag = false;
          textBlockClosed = false;
          pendingEventName = "";
          return;
        }

        if (!inToolTag && HAS_OPEN_TOOL_TAG(textBuffer)) {
          inToolTag = true;
          log?.debug?.("TOOLSHIM", "Detected tool call tag in stream buffer");
        }

        if (inToolTag && HAS_CLOSE_TOOL_TAG(textBuffer)) {
          const parsed = parseUniversalToolCalls(textBuffer, declaredNames);
          if (parsed.hasToolCalls) {
            const unclosedState = extractUnclosedBuffer(parsed.text || "");

            // Emit text BEFORE tool call chunk if clean text preceded the tag
            if (unclosedState.cleanText && unclosedState.cleanText.trim()) {
              emitTextChunk(unclosedState.cleanText, json, clientFormat, controller);
            }

            // For Claude format: close any open block before emitting tool_use blocks
            if (clientFormat === "claude" && !textBlockClosed) {
              if (openBlockIndex >= 0) {
                // Close the currently open upstream block — but skip if its
                // start was dropped (empty text block): emitting an orphan stop
                // breaks Claude Code's block state machine and stalls it.
                if (!droppedBlockIndices.has(openBlockIndex)) {
                  const closeBlock = `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: openBlockIndex })}\n\n`;
                  controller.enqueue(new TextEncoder().encode(closeBlock));
                } else {
                  droppedBlockIndices.delete(openBlockIndex);
                }
                openBlockIndex = -1;
              } else if (nextBlockIndex === 0) {
                // No upstream blocks seen — legacy: assume block 0 exists
                const closeTextBlock = `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`;
                controller.enqueue(new TextEncoder().encode(closeTextBlock));
                nextBlockIndex = 1;
              }
              textBlockClosed = true;
            }

            const totalCalls = parsed.toolCalls.length;
            for (let i = 0; i < totalCalls; i++) {
              const tc = parsed.toolCalls[i];
              log?.info?.("TOOLSHIM", `Stream parsed tool call: ${tc.function.name}`);
              emitToolCallChunk(tc, toolCallCounter++, clientFormat, controller);
              hasEmittedToolCalls = true;
            }

            textBuffer = unclosedState.remainingBuffer;
            inToolTag = unclosedState.inTag;
            pendingEventName = "";
            return;
          } else {
            log?.warn?.("TOOLSHIM", "Failed or rejected tool_call JSON from XML tag, emitting clean text");
            inToolTag = false;
            if (parsed.text && parsed.text.trim()) {
              emitTextChunk(parsed.text, json, clientFormat, controller);
            }
            textBuffer = "";
            pendingEventName = "";
            return;
          }
        }

        if (!inToolTag && textBuffer) {
          const holdLen = getPartialTagPrefixLength(textBuffer);
          if (holdLen > 0) {
            const safeText = textBuffer.slice(0, textBuffer.length - holdLen);
            if (safeText && safeText.trim()) {
              emitTextChunk(safeText, json, clientFormat, controller);
            }
            textBuffer = textBuffer.slice(textBuffer.length - holdLen);
          } else {
            if (textBuffer.trim()) {
              emitTextChunk(textBuffer, json, clientFormat, controller);
            }
            textBuffer = "";
          }
        }
        pendingEventName = "";
        return;
      }

      // Pass non-text data events (e.g. message_start, content_block_start, ping) through when not inside tool tag
      // But track empty text blocks: if a text block starts with no content, don't forward it
      if (!inToolTag && !hasEmittedToolCalls) {
        if (json.type === "content_block_start" && json.content_block?.type === "text" && !json.content_block?.text) {
          // Empty text block — buffer and skip unless deltas arrive
          pendingEmptyTextBlockIndex = json.index;
          droppedBlockIndices.add(json.index);
          pendingEventName = "";
          return;
        }
        if (pendingEmptyTextBlockIndex >= 0) {
          if (json.type === "content_block_delta" && json.index === pendingEmptyTextBlockIndex) {
            // Real content arrived — forward the buffered start then continue
            controller.enqueue(new TextEncoder().encode(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: pendingEmptyTextBlockIndex, content_block: { type: "text", text: "" } })}\n\n`));
            pendingEmptyTextBlockIndex = -1;
            droppedBlockIndices.delete(json.index);
          } else if (json.type === "content_block_stop" && json.index === pendingEmptyTextBlockIndex) {
            // Empty text block closed with no content — drop entirely
            pendingEmptyTextBlockIndex = -1;
            pendingEventName = "";
            return;
          } else if (json.type === "content_block_delta" && json.index !== pendingEmptyTextBlockIndex) {
            // delta for a different block — forward buffered empty start is not needed, drop it
            pendingEmptyTextBlockIndex = -1;
          }
        }
        if (pendingEventName) {
          controller.enqueue(new TextEncoder().encode(`event: ${pendingEventName}\n`));
          pendingEventName = "";
        }
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      } else if (droppedBlockIndices.has(json.index) && json.type === "content_block_stop") {
        // A stop for a block whose start was dropped — drop the stop too
        droppedBlockIndices.delete(json.index);
        pendingEventName = "";
        return;
      } else {
        pendingEventName = "";
      }
    } catch {
      if (!inToolTag && !hasEmittedToolCalls) {
        if (pendingEventName) {
          controller.enqueue(new TextEncoder().encode(`event: ${pendingEventName}\n`));
          pendingEventName = "";
        }
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      } else {
        pendingEventName = "";
      }
    }
  }

  function emitToolCallChunk(tc, index, format, controller) {
    if (format === "claude") {
      const blockIndex = nextBlockIndex++;
      const toolUseId = tc.id || `toolu_${Date.now()}_${index}`;

      const blockStart = `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "tool_use", id: toolUseId, name: tc.function.name, input: {}, ...(tc.is_error ? { is_error: true } : {}) }
      })}\n\n`;

      let partialJsonStr = "{}";
      try {
        const argsObj = repairAndParseJson(tc.function.arguments || "{}");
        partialJsonStr = JSON.stringify(argsObj);
      } catch {
        partialJsonStr = tc.function.arguments || "{}";
      }

      const blockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: partialJsonStr }
      })}\n\n`;

      const blockStop = `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: blockIndex
      })}\n\n`;

      controller.enqueue(new TextEncoder().encode(blockStart + blockDelta + blockStop));
    } else {
      const ssePayload = `data: ${JSON.stringify({
        id: `chatcmpl-shim-${Date.now()}-${index}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index,
              id: tc.id,
              type: "function",
              function: tc.function
            }]
          },
          finish_reason: null
        }]
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(ssePayload));
    }
  }

  function emitTextChunk(text, originalJson, format, controller) {
    if (format === "claude") {
      // If text block 0 was already closed (tool calls emitted), open a new text block
      if (textBlockClosed) {
        const newBlockIndex = nextBlockIndex++;
        openBlockIndex = newBlockIndex;
        const blockStart = `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: newBlockIndex,
          content_block: { type: "text", text: "" }
        })}\n\n`;
        const blockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: newBlockIndex,
          delta: { type: "text_delta", text }
        })}\n\n`;
        const blockStop = `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: newBlockIndex
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(blockStart + blockDelta + blockStop));
      } else {
        // Use the currently open upstream block index, or allocate a new one
        const targetIndex = openBlockIndex >= 0 ? openBlockIndex : (nextBlockIndex === 0 ? 0 : nextBlockIndex++);
        if (openBlockIndex < 0 && nextBlockIndex === 0) {
          // No upstream blocks seen, use index 0
          nextBlockIndex = 1;
        }
        const ssePayload = `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: targetIndex,
          delta: { type: "text_delta", text }
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(ssePayload));
      }
    } else {
      const ssePayload = `data: ${JSON.stringify({
        id: originalJson?.id || "chatcmpl-shim-text",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text } }]
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(ssePayload));
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      const raw = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
      sseLineBuffer += raw;

      const lines = sseLineBuffer.split("\n");
      sseLineBuffer = lines.pop() || ""; // Keep trailing incomplete line in buffer

      for (const line of lines) {
        processLine(line, controller);
      }
    },
    flush(controller) {
      // Drain remaining sseLineBuffer if not empty
      if (sseLineBuffer.trim().length > 0) {
        processLine(sseLineBuffer, controller);
        sseLineBuffer = "";
      }

      // Emit any remaining text in textBuffer
      if (textBuffer.length > 0) {
        emitTextChunk(textBuffer, null, clientFormat, controller);
        textBuffer = "";
      }

      // Emit terminal tool_calls finish_reason / stop_reason BEFORE [DONE] or message_stop
      if (hasEmittedToolCalls) {
        if (clientFormat === "claude") {
          controller.enqueue(new TextEncoder().encode(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`));
          controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        } else {
          const finishChunk = `data: ${JSON.stringify({
            id: `chatcmpl-shim-finish-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
          })}\n\n`;
          controller.enqueue(new TextEncoder().encode(finishChunk));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        }
      } else if (!sawMessageStop) {
        if (clientFormat === "claude") {
          controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        } else {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        }
      }
    }
  });
}
