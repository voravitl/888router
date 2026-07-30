// Inbound Multi-Turn History Adapter (Layer 2)
// Rewrites previous tool_calls and tool_result history turns into taught prose format
// so non-tool-tuned models understand multi-turn agent interaction loops.

/**
 * Rewrites tool_calls and tool_result history messages for models using the Universal Tool Shim.
 */
export function adaptHistoryForUniversalTools(body) {
  if (!body.messages || !Array.isArray(body.messages)) {
    return body;
  }

  const adaptedMessages = [];
  const toolCallNames = new Map(); // id -> name mapping

  for (const msg of body.messages) {
    // 1. Assistant message containing tool_calls or tool_use
    if (msg.role === "assistant") {
      let contentStr = typeof msg.content === "string" ? msg.content : "";
      const toolCalls = msg.tool_calls;

      if (toolCalls && Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const name = tc.function?.name || tc.name || "unknown_tool";
          const args = tc.function?.arguments || tc.arguments || "{}";
          if (tc.id) toolCallNames.set(tc.id, name);

          const xmlTag = `<tool_call>\n{"name": "${name}", "arguments": ${typeof args === "string" ? args : JSON.stringify(args)}}\n</tool_call>`;
          contentStr = contentStr ? `${contentStr}\n${xmlTag}` : xmlTag;
        }
        adaptedMessages.push({ role: "assistant", content: contentStr });
        continue;
      }
    }

    // 2. Tool message (role: "tool") in OpenAI format
    if (msg.role === "tool") {
      const toolName = toolCallNames.get(msg.tool_call_id) || "tool";
      const resultText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      const proseContent = `Tool Output [${toolName}]:\n${resultText}`;

      adaptedMessages.push({
        role: "user",
        content: proseContent
      });
      continue;
    }

    // 3. User message containing tool_result blocks in Anthropic format
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const newContent = [];
      let convertedToProse = false;

      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const toolName = toolCallNames.get(block.tool_use_id) || "tool";
          const resultText = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(b => b.text || "").join("\n")
              : JSON.stringify(block.content || "");
          
          newContent.push({
            type: "text",
            text: `Tool Output [${toolName}]:\n${resultText}`
          });
          convertedToProse = true;
        } else {
          newContent.push(block);
        }
      }

      if (convertedToProse) {
        adaptedMessages.push({ role: "user", content: newContent });
        continue;
      }
    }

    // Keep all other regular messages unchanged
    adaptedMessages.push(msg);
  }

  body.messages = adaptedMessages;
  return body;
}
