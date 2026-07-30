// Stateful SSE Stream State Machine (Layer 3)
// Intercepts streaming text chunks from non-tool models and buffers <tool_call> tags
// to emit standard SSE tool_calls events to the client.

import { parseUniversalToolCalls, getDeclaredToolNames } from "../translator/concerns/universalToolParser.js";

/**
 * Creates a TransformStream that inspects SSE streams for <tool_call> tags.
 */
export function createStreamToolShimTransformStream(tools = []) {
  const declaredNames = getDeclaredToolNames(tools);
  let buffer = "";
  let inToolTag = false;

  return new TransformStream({
    transform(chunk, controller) {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      buffer += text;

      if (!inToolTag && buffer.includes("<tool_call>")) {
        inToolTag = true;
      }

      if (inToolTag && buffer.includes("</tool_call>")) {
        // Tag completed inside buffer
        const parsed = parseUniversalToolCalls(buffer, declaredNames);
        if (parsed.hasToolCalls) {
          for (const tc of parsed.toolCalls) {
            const sseEvent = `data: ${JSON.stringify({
              id: "chatcmpl-toolshim-" + Date.now(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [tc]
                },
                finish_reason: "tool_calls"
              }]
            })}\n\ndata: [DONE]\n\n`;
            controller.enqueue(new TextEncoder().encode(sseEvent));
          }
          buffer = parsed.text || "";
          inToolTag = false;
          return;
        }
      }

      // If not buffering a tool tag, pass text through
      if (!inToolTag) {
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        buffer = "";
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(new TextEncoder().encode(buffer));
      }
    }
  });
}
