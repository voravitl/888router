// Stateful SSE Stream State Machine (Layer 3)
// Intercepts streaming text chunks from non-tool models, parses delta text from SSE JSON payloads,
// buffers <tool_call> XML tags across chunk boundaries, and emits spec-compliant SSE tool_calls events.

import { parseUniversalToolCalls, getDeclaredToolNames } from "../translator/concerns/universalToolParser.js";

const MAX_BUFFER_SIZE = 64 * 1024; // 64KB safety cap against memory DoS

const TAG_PREFIXES = [
  "<tool_call>",
  "<tool_use>",
  "</tool_call>",
  "</tool_use>"
];

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
 * Creates a TransformStream that inspects SSE streams for <tool_call> tags and transforms them to tool_calls SSE events.
 * Supports both OpenAI SSE format and Claude SSE format (content_block_start/delta).
 */
export function createStreamToolShimTransformStream(tools = [], clientFormat = "openai", log = null) {
  const declaredNames = getDeclaredToolNames(tools);
  let textBuffer = "";
  let sseLineBuffer = "";
  let pendingEventName = "";
  let inToolTag = false;
  let toolCallCounter = 0;
  let sawMessageStop = false;
  let textBlockClosed = false;

  function processLine(line, controller) {
    const trimmed = line.trim();

    if (trimmed.startsWith("event: ")) {
      pendingEventName = trimmed.slice(7).trim();
      return; // Hold event line until data line arrives
    }

    // Pass non-data lines directly when not buffering inside tool tag
    if (!trimmed.startsWith("data: ")) {
      if (!inToolTag) {
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
      if (!inToolTag) {
        sawMessageStop = true;
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
      pendingEventName = "";
      return;
    }

    try {
      const json = JSON.parse(dataStr);
      if (json.type === "message_stop" && !inToolTag) {
        sawMessageStop = true;
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
          pendingEventName = "";
          return;
        }

        if (!inToolTag && (textBuffer.includes("<tool_call>") || textBuffer.includes("<tool_use>"))) {
          inToolTag = true;
          log?.debug?.("TOOLSHIM", "Detected <tool_call> tag in stream buffer");
        }

        if (inToolTag && (textBuffer.includes("</tool_call>") || textBuffer.includes("</tool_use>"))) {
          const parsed = parseUniversalToolCalls(textBuffer, declaredNames);
          if (parsed.hasToolCalls) {
            // Emit text BEFORE tool call chunk if text preceded the tag
            if (parsed.text && parsed.text.trim()) {
              emitTextChunk(parsed.text, json, clientFormat, controller);
            }

            // For Claude format: close text block (index 0) ONCE before emitting any tool_use blocks
            if (clientFormat === "claude" && !textBlockClosed) {
              const closeTextBlock = `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`;
              controller.enqueue(new TextEncoder().encode(closeTextBlock));
              textBlockClosed = true;
            }

            const totalCalls = parsed.toolCalls.length;
            for (let i = 0; i < totalCalls; i++) {
              const tc = parsed.toolCalls[i];
              const isLast = i === totalCalls - 1;
              log?.info?.("TOOLSHIM", `Stream parsed tool call: ${tc.function.name}`);
              emitToolCallChunk(tc, toolCallCounter++, clientFormat, controller, isLast);
            }

            textBuffer = "";
            inToolTag = false;
            pendingEventName = "";
            return;
          } else {
            log?.warn?.("TOOLSHIM", "Failed to parse tool_call JSON from XML tag, falling back to text");
            inToolTag = false;
          }
        }

        if (!inToolTag && textBuffer) {
          const holdLen = getPartialTagPrefixLength(textBuffer);
          if (holdLen > 0) {
            const safeText = textBuffer.slice(0, textBuffer.length - holdLen);
            if (safeText) {
              emitTextChunk(safeText, json, clientFormat, controller);
            }
            textBuffer = textBuffer.slice(textBuffer.length - holdLen);
          } else {
            emitTextChunk(textBuffer, json, clientFormat, controller);
            textBuffer = "";
          }
        }
        pendingEventName = "";
        return;
      }

      // Pass non-text data events (e.g. message_start, content_block_start, ping) through when not inside tool tag
      if (!inToolTag) {
        if (pendingEventName) {
          controller.enqueue(new TextEncoder().encode(`event: ${pendingEventName}\n`));
          pendingEventName = "";
        }
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      } else {
        pendingEventName = "";
      }
    } catch {
      if (!inToolTag) {
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

  function emitToolCallChunk(tc, index, format, controller, isLast = true) {
    if (format === "claude") {
      const blockIndex = index + 1; // Index 0 was closed
      const toolUseId = tc.id || `toolu_${Date.now()}_${index}`;

      const blockStart = `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "tool_use", id: toolUseId, name: tc.function.name, input: {} }
      })}\n\n`;

      let argsObj = {};
      try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch { }

      const blockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(argsObj) }
      })}\n\n`;

      const blockStop = `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: blockIndex
      })}\n\n`;

      let payload = blockStart + blockDelta + blockStop;

      // Emit message_delta with stop_reason: tool_use ONLY ONCE on final tool call chunk
      if (isLast) {
        payload += `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use" }
        })}\n\n`;
      }

      controller.enqueue(new TextEncoder().encode(payload));
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
          finish_reason: isLast ? "tool_calls" : null
        }]
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(ssePayload));
    }
  }

  function emitTextChunk(text, originalJson, format, controller) {
    if (format === "claude") {
      const ssePayload = `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text }
      })}\n\n`;
      controller.enqueue(new TextEncoder().encode(ssePayload));
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

      if (!sawMessageStop) {
        if (clientFormat === "claude") {
          controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        } else {
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        }
      }
    }
  });
}
