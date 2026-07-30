// Universal Tool Call Response Parser (Layer 3)
// Extracts XML <tool_call> tags, Markdown JSON blocks, or ReAct patterns from raw assistant output
// and converts them to standard tool_calls format with Strict Schema Name Matching.

import { repairAndParseJson } from "./jsonAutoRepair.js";
import { generateToolCallId } from "./toolCall.js";

const XML_TOOL_CALL_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>|<tool_use>([\s\S]*?)<\/tool_use>/gi;
const MARKDOWN_JSON_REGEX = /```json\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/gi;

/**
 * Extracts declared tool names from body.tools array for Strict Schema Name Matching
 */
export function getDeclaredToolNames(tools) {
  const names = new Set();
  if (!tools || !Array.isArray(tools)) return names;

  for (const t of tools) {
    if (t.function?.name) names.add(t.function.name);
    else if (t.name) names.add(t.name);
  }
  return names;
}

/**
 * Parses raw text response and extracts valid tool_calls.
 * Emits standard OpenAI `tool_calls` array if matches are found.
 */
export function parseUniversalToolCalls(text, declaredToolNames = new Set()) {
  if (!text || typeof text !== "string") {
    return { hasToolCalls: false, text, toolCalls: [] };
  }

  const toolCalls = [];
  let cleanText = text;

  // 1. Try matching XML <tool_call> or <tool_use> tags
  let xmlMatch;
  while ((xmlMatch = XML_TOOL_CALL_REGEX.exec(text)) !== null) {
    const rawJsonContent = xmlMatch[1] || xmlMatch[2];
    const parsed = repairAndParseJson(rawJsonContent);

    // Always strip matched XML tag from cleanText
    cleanText = cleanText.replace(xmlMatch[0], "").trim();

    if (parsed && parsed.name && (declaredToolNames.size === 0 || declaredToolNames.has(parsed.name))) {
      const toolName = parsed.name;
      const toolArgs = typeof parsed.arguments === "string"
        ? parsed.arguments
        : JSON.stringify(parsed.arguments || {});

      toolCalls.push({
        id: generateToolCallId(0, toolCalls.length, toolName),
        type: "function",
        function: {
          name: toolName,
          arguments: toolArgs
        }
      });
    }
  }

  // 2. Try matching Markdown ```json {"name": ...} ``` code blocks if XML matched nothing
  if (toolCalls.length === 0) {
    let mdMatch;
    while ((mdMatch = MARKDOWN_JSON_REGEX.exec(text)) !== null) {
      const rawJsonContent = mdMatch[1];
      const parsed = repairAndParseJson(rawJsonContent);

      if (parsed && parsed.name && (declaredToolNames.size === 0 || declaredToolNames.has(parsed.name))) {
        const toolName = parsed.name;
        const toolArgs = typeof parsed.arguments === "string"
          ? parsed.arguments
          : JSON.stringify(parsed.arguments || {});

        toolCalls.push({
          id: generateToolCallId(0, toolCalls.length, toolName),
          type: "function",
          function: {
            name: toolName,
            arguments: toolArgs
          }
        });
        cleanText = cleanText.replace(mdMatch[0], "").trim();
      }
    }
  }

  if (toolCalls.length > 0) {
    return {
      hasToolCalls: true,
      text: cleanText.length > 0 ? cleanText : null,
      toolCalls
    };
  }

  return { hasToolCalls: false, text: cleanText, toolCalls: [] };
}
