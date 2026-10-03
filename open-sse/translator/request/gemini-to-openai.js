import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { collapseTextParts } from "../concerns/message.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK } from "../schema/index.js";

function unsupportedRequest(message) {
  const error = new Error(message);
  error.code = "unsupported_request";
  return error;
}

// Convert Gemini request to OpenAI format
export function geminiToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Generation config
  if (body.generationConfig) {
    const config = body.generationConfig;
    if (config.maxOutputTokens) {
      const tempBody = { max_tokens: config.maxOutputTokens, tools: body.tools };
      result.max_tokens = adjustMaxTokens(tempBody);
    }
    if (config.temperature !== undefined) {
      result.temperature = config.temperature;
    }
    if (config.topP !== undefined) {
      result.top_p = config.topP;
    }
  }

  // System instruction
  if (body.systemInstruction) {
    const systemText = extractGeminiText(body.systemInstruction);
    if (systemText) {
      result.messages.push({
        role: ROLE.SYSTEM,
        content: systemText
      });
    }
  }

  // Convert contents to messages
  if (body.contents && Array.isArray(body.contents)) {
    const callState = { pending: new Map(), counts: new Map() };
    for (const content of body.contents) {
      result.messages.push(...convertGeminiContent(content, callState));
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          result.tools.push({
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: func.name,
              description: func.description || "",
              parameters: func.parameters || { type: "object", properties: {} }
            }
          });
        }
      }
    }
  }

  const calling = body.toolConfig?.functionCallingConfig;
  if (calling?.mode === "NONE") result.tool_choice = "none";
  else if (calling?.mode === "AUTO") result.tool_choice = "auto";
  else if (calling?.mode === "ANY") {
    const allowed = calling.allowedFunctionNames;
    if (Array.isArray(allowed) && allowed.length) {
      result.tools = (result.tools || []).filter((tool) => allowed.includes(tool.function.name));
      if (result.tools.length !== new Set(allowed).size) {
        throw unsupportedRequest("Gemini allowedFunctionNames must refer to declared tools.");
      }
      result.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0] } } : "required";
    } else result.tool_choice = "required";
  } else if (calling?.mode) {
    throw unsupportedRequest("Unsupported Gemini function calling mode for cross-format translation.");
  }

  return result;
}

// A Gemini turn may combine several function responses with user text/media.
// Emit every group in source order instead of returning at the first result.
function convertGeminiContent(content, callState) {
  const role = content.role === GEMINI_ROLE.MODEL ? ROLE.ASSISTANT : ROLE.USER;
  if (!Array.isArray(content.parts)) return [];
  const messages = [];
  let parts = [];
  let toolCalls = [];

  function flush() {
    if (!parts.length && !toolCalls.length) return;
    const message = { role: toolCalls.length ? ROLE.ASSISTANT : role };
    if (parts.length) message.content = collapseTextParts(parts);
    if (toolCalls.length) message.tool_calls = toolCalls;
    messages.push(message);
    parts = [];
    toolCalls = [];
  }

  for (const part of content.parts) {
    const supportedFields = new Set(["text", "inlineData", "functionCall", "functionResponse", "thought", "thoughtSignature"]);
    if (Object.keys(part).some((key) => !supportedFields.has(key))) {
      throw unsupportedRequest("Unsupported Gemini content part for cross-format translation; use a native Gemini route.");
    }
    let supported = false;
    if (part.text !== undefined) {
      parts.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
      supported = true;
    }
    if (part.inlineData) {
      if (!String(part.inlineData.mimeType || "").startsWith("image/")) {
        throw unsupportedRequest("Gemini inline media cannot be translated to this chat format; use a native Gemini route.");
      }
      parts.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: encodeDataUri(part.inlineData.mimeType, part.inlineData.data) } });
      supported = true;
    }
    if (part.functionCall) {
      const call = part.functionCall;
      const count = (callState.counts.get(call.name) || 0) + 1;
      callState.counts.set(call.name, count);
      const id = call.id || `call_${call.name}${count > 1 ? `_${count}` : ""}`;
      const queue = callState.pending.get(call.name) || [];
      queue.push(id);
      callState.pending.set(call.name, queue);
      toolCalls.push({ id, type: OPENAI_BLOCK.FUNCTION, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } });
      supported = true;
    }
    if (part.functionResponse) {
      const response = part.functionResponse;
      if (parts.length || toolCalls.length) {
        throw unsupportedRequest("Interleaved Gemini content and tool results cannot retain their order in this chat format; use a native Gemini route.");
      }
      if (response.parts?.length) {
        throw unsupportedRequest("Gemini tool-result media cannot be translated to this chat format; use a native Gemini route.");
      }
      flush();
      const queue = callState.pending.get(response.name) || [];
      const id = response.id || queue[0] || `call_${response.name}`;
      const index = queue.indexOf(id);
      if (index >= 0) queue.splice(index, 1);
      messages.push({ role: ROLE.TOOL, tool_call_id: id, content: JSON.stringify(response.response ?? {}) });
      supported = true;
    }
    // Unsupported file/video/audio/future payload parts must not disappear.
    if (!supported && Object.keys(part).length) {
      throw unsupportedRequest("Unsupported Gemini content part for cross-format translation; use a native Gemini route.");
    }
  }
  flush();
  return messages;
}

// Extract text from Gemini content
function extractGeminiText(content) {
  if (typeof content === "string") return content;
  if (content.parts && Array.isArray(content.parts)) {
    return content.parts.map(p => p.text || "").join("");
  }
  return "";
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, geminiToOpenAIRequest, null);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, geminiToOpenAIRequest, null);
