// Stateful SSE Stream State Machine (Layer 3)
// Intercepts streaming text chunks from non-tool models, parses delta text from SSE JSON payloads,
// buffers <tool_call> XML tags across chunk boundaries, and emits spec-compliant SSE tool_calls events.

import { parseUniversalToolCalls, getDeclaredToolNames } from "../translator/concerns/universalToolParser.js";

const MAX_BUFFER_SIZE = 64 * 1024; // 64KB safety cap against memory DoS

/**
 * Creates a TransformStream that inspects SSE streams for <tool_call> tags and transforms them to tool_calls SSE events.
 * Supports both OpenAI SSE format and Claude SSE format (content_block_start/delta).
 */
export function createStreamToolShimTransformStream(tools = [], clientFormat = "openai") {
  const declaredNames = getDeclaredToolNames(tools);
  let textBuffer = "";
  let sseLineBuffer = "";
  let inToolTag = false;
  let toolCallCounter = 0;

  function processLine(line, controller) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) {
      if (!inToolTag) {
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      }
      return;
    }

    const dataStr = trimmed.slice(6).trim();
    if (dataStr === "[DONE]") return;

    try {
      const json = JSON.parse(dataStr);
      
      // Extract delta text content across OpenAI or Claude SSE formats
      let deltaContent = "";
      if (json.choices?.[0]?.delta?.content !== undefined) {
        deltaContent = json.choices[0].delta.content || "";
      } else if (json.type === "content_block_delta" && json.delta?.text) {
        deltaContent = json.delta.text;
      } else if (typeof json.content === "string") {
        deltaContent = json.content;
      }

      if (deltaContent) {
        textBuffer += deltaContent;

        // Prevent memory DoS
        if (textBuffer.length > MAX_BUFFER_SIZE) {
          emitTextChunk(textBuffer, json, clientFormat, controller);
          textBuffer = "";
          inToolTag = false;
          return;
        }

        if (!inToolTag && textBuffer.includes("<tool_call>")) {
          inToolTag = true;
        }

        if (inToolTag && (textBuffer.includes("</tool_call>") || textBuffer.includes("</tool_use>"))) {
          const parsed = parseUniversalToolCalls(textBuffer, declaredNames);
          if (parsed.hasToolCalls) {
            for (const tc of parsed.toolCalls) {
              emitToolCallChunk(tc, toolCallCounter++, clientFormat, controller);
            }
            textBuffer = parsed.text || "";
            inToolTag = false;
            return;
          } else {
            inToolTag = false;
          }
        }

        if (!inToolTag && textBuffer) {
          emitTextChunk(textBuffer, json, clientFormat, controller);
          textBuffer = "";
        }
      }
    } catch {
      if (!inToolTag) {
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      }
    }
  }

  function emitToolCallChunk(tc, index, format, controller) {
    if (format === "claude") {
      const toolUseId = tc.id || `toolu_${Date.now()}_${index}`;
      const blockStart = `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: toolUseId, name: tc.function.name, input: {} }
      })}\n\n`;

      let argsObj = {};
      try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch { }

      const blockDelta = `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(argsObj) }
      })}\n\n`;

      const blockStop = `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index
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
          finish_reason: "tool_calls"
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

      if (clientFormat === "claude") {
        controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
      } else {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
    }
  });
}
