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

  const rawAdapted = [];
  const toolCallNames = new Map(); // id -> name mapping

  for (const msg of body.messages) {
    if (!msg) continue;

    // 1. Assistant message containing tool_calls or Anthropic tool_use blocks
    if (msg.role === "assistant") {
      let contentStr = typeof msg.content === "string" ? msg.content : "";
      
      // OpenAI tool_calls
      const toolCalls = msg.tool_calls;
      if (toolCalls && Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const name = tc.function?.name || tc.name || "unknown_tool";
          const args = tc.function?.arguments || tc.arguments || "{}";
          if (tc.id) toolCallNames.set(tc.id, name);

          const xmlTag = `<tool_call>\n{"name": ${JSON.stringify(name)}, "arguments": ${typeof args === "string" ? args : JSON.stringify(args)}}\n</tool_call>`;
          contentStr = contentStr ? `${contentStr}\n${xmlTag}` : xmlTag;
        }
        rawAdapted.push({ role: "assistant", content: contentStr });
        continue;
      }

      // Anthropic tool_use content blocks
      if (Array.isArray(msg.content)) {
        const textParts = [];
        const xmlParts = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name || "unknown_tool";
            if (block.id) toolCallNames.set(block.id, name);
            xmlParts.push(`<tool_call>\n{"name": ${JSON.stringify(name)}, "arguments": ${JSON.stringify(block.input || {})}}\n</tool_call>`);
          }
        }
        if (xmlParts.length > 0) {
          const combined = [...textParts, ...xmlParts].join("\n");
          rawAdapted.push({ role: "assistant", content: combined });
          continue;
        }
      }
    }

    // 2. Tool message (role: "tool") in OpenAI format
    if (msg.role === "tool") {
      const toolName = toolCallNames.get(msg.tool_call_id) || "tool";
      const resultText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      const proseContent = `Tool Output [${toolName}]:\n${resultText}`;

      rawAdapted.push({
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
        rawAdapted.push({ role: "user", content: newContent });
        continue;
      }
    }

    // Keep all other regular messages unchanged
    rawAdapted.push(msg);
  }

  // Merge consecutive user messages to prevent role duplication errors
  const finalMessages = [];
  for (const m of rawAdapted) {
    const prev = finalMessages[finalMessages.length - 1];
    if (prev && prev.role === "user" && m.role === "user") {
      const prevText = typeof prev.content === "string" ? prev.content : JSON.stringify(prev.content);
      const currText = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      prev.content = `${prevText}\n\n${currText}`;
    } else {
      finalMessages.push(m);
    }
  }

  body.messages = finalMessages;
  return body;
}
