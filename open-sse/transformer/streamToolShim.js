// Stateful SSE Stream State Machine (Layer 3)
// Intercepts streaming text chunks from non-tool models, parses delta text from SSE JSON payloads,
// buffers <tool_call> XML tags across chunk boundaries, and emits standard OpenAI SSE tool_calls events.

import { parseUniversalToolCalls, getDeclaredToolNames } from "../translator/concerns/universalToolParser.js";

const MAX_BUFFER_SIZE = 64 * 1024; // 64KB safety cap against memory DoS

/**
 * Creates a TransformStream that inspects SSE streams for <tool_call> tags and transforms them to tool_calls SSE events.
 */
export function createStreamToolShimTransformStream(tools = []) {
  const declaredNames = getDeclaredToolNames(tools);
  let textBuffer = "";
  let sseLineBuffer = "";
  let inToolTag = false;
  let toolCallCounter = 0;

  return new TransformStream({
    transform(chunk, controller) {
      const raw = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
      sseLineBuffer += raw;

      const lines = sseLineBuffer.split("\n");
      sseLineBuffer = lines.pop() || ""; // keep incomplete trailing line in line buffer

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6).trim();

          if (dataStr === "[DONE]") {
            continue; // We will emit [DONE] on flush
          }

          try {
            const json = JSON.parse(dataStr);
            const deltaContent = json.choices?.[0]?.delta?.content || json.content || "";

            if (deltaContent) {
              textBuffer += deltaContent;

              // Prevent memory DoS if buffer exceeds max size
              if (textBuffer.length > MAX_BUFFER_SIZE) {
                const passthroughEvent = `data: ${JSON.stringify({
                  id: "chatcmpl-shim-overflow",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: textBuffer } }]
                })}\n\n`;
                controller.enqueue(new TextEncoder().encode(passthroughEvent));
                textBuffer = "";
                inToolTag = false;
                continue;
              }

              if (!inToolTag && textBuffer.includes("<tool_call>")) {
                inToolTag = true;
              }

              if (inToolTag && (textBuffer.includes("</tool_call>") || textBuffer.includes("</tool_use>"))) {
                const parsed = parseUniversalToolCalls(textBuffer, declaredNames);
                if (parsed.hasToolCalls) {
                  for (const tc of parsed.toolCalls) {
                    const ssePayload = `data: ${JSON.stringify({
                      id: `chatcmpl-shim-${Date.now()}-${toolCallCounter}`,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      choices: [{
                        index: 0,
                        delta: {
                          role: "assistant",
                          tool_calls: [{
                            index: toolCallCounter++,
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
                  textBuffer = parsed.text || "";
                  inToolTag = false;
                  continue;
                } else {
                  // Complete tag failed parsing; reset tag flag and flush textBuffer as normal content
                  inToolTag = false;
                }
              }

              // Pass plain text delta through if not inside <tool_call>
              if (!inToolTag && textBuffer) {
                const passthroughEvent = `data: ${JSON.stringify({
                  id: json.id || "chatcmpl-shim-text",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: textBuffer } }]
                })}\n\n`;
                controller.enqueue(new TextEncoder().encode(passthroughEvent));
                textBuffer = "";
              }
              continue;
            }
          } catch {
            // Not JSON data line; pass through verbatim
          }
        }

        // Pass non-data lines through
        if (!inToolTag) {
          controller.enqueue(new TextEncoder().encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      if (textBuffer.length > 0) {
        const passthroughEvent = `data: ${JSON.stringify({
          id: "chatcmpl-shim-flush",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: textBuffer } }]
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(passthroughEvent));
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    }
  });
}
