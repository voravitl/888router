/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { normalizeResponsesInput } from "../formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

// Responses API enforces max 64 chars on call_id (#393)
const MAX_CALL_ID_LEN = 64;
const clampCallId = (id) => (typeof id === "string" && id.length > MAX_CALL_ID_LEN ? id.substring(0, MAX_CALL_ID_LEN) : id);

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  let pendingReasoning = "";

  const inputItems = normalizeResponsesInput(body.input);
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text or encrypted_content fallback
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      const msg = { role: item.role, content };
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo thinking mode)
      if (item.role === ROLE.ASSISTANT && pendingReasoning) {
        msg.reasoning_content = pendingReasoning;
      }
      pendingReasoning = "";
      result.messages.push(msg);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        if (pendingReasoning) {
          currentAssistantMsg.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
      }
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      currentAssistantMsg.tool_calls.push({
        id: item.call_id,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: item.arguments
        }
      });
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush any pending tool results first
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }
      // Add tool result immediately
      result.messages.push({
        role: ROLE.TOOL,
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output)
      });
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Buffer reasoning text; attached to next assistant message/function_call
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools
      .map(tool => {
        // Already in Chat Completions format: { type: "function", function: { name, ... } }
        if (tool.function) return tool;
        // Responses API function tool: { type: "function", name, description, parameters }
        // Only convert when a non-empty name is present; skip hosted tools without one.
        const name = tool.name;
        if (!name || typeof name !== "string" || name.trim() === "") return null;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name,
            description: String(tool.description || ""),
            parameters: normalizeToolParameters(tool.parameters),
            strict: tool.strict
          }
        };
      })
      .filter(Boolean);
  }

  // Cleanup Responses API specific fields
  // Map Responses-only max_output_tokens to Chat max_tokens (avoid leaking unknown field upstream)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  delete result.reasoning;
  delete result.client_metadata;

  return result;
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  // Body already in Responses API format (e.g. Cursor CLI calling /chat/completions with input[])
  if (body.input) return { ...body, model, stream: true };

  const result = {
    model,
    input: [],
    stream: true,
    store: false
  };

  // Extract initial contiguous system/developer prefix into instructions; preserve mid-conversation turns
  let initialPrefixActive = true;
  const initialInstructions = [];
  const messages = body.messages || [];
  const generatedCallIds = new Map();
  let generatedCallSeq = 0;
  const pendingAssistantCallIds = [];
  const resolveCallId = (rawId, fallbackKey) => {
    const clamped = clampCallId(rawId);
    if (clamped && clamped.trim()) return clamped.trim();
    const key = rawId || fallbackKey;
    if (!key) return null;
    if (!generatedCallIds.has(key)) {
      generatedCallIds.set(key, `call_${fallbackKey}_${generatedCallSeq++}`);
    }
    return generatedCallIds.get(key);
  };

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER) {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => (typeof c === "string" ? c : (typeof c?.text === "string" ? c.text : ""))).filter(Boolean).join("\n")
          : "";
      if (initialPrefixActive) {
        if (text) initialInstructions.push(text);
      } else if (text) {
        // Keep temporal scope of mid-conversation system/developer turns as developer input items
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: "developer",
          content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text }]
        });
      }
      continue; // Handled
    }

    // Any non-system/developer turn ends the initial instructions prefix
    initialPrefixActive = false;

    // Convert user/assistant messages to input items
    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      const contentType = msg.role === ROLE.USER ? RESPONSES_ITEM.INPUT_TEXT : RESPONSES_ITEM.OUTPUT_TEXT;
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === OPENAI_BLOCK.TEXT) return { type: contentType, text: c.text };
            // Convert Chat Completions image_url → Responses API input_image
            // Responses API expects: { type: "input_image", image_url: "<url string>" }
            // Chat Completions sends: { type: "image_url", image_url: { url: "...", detail: "..." } }
            if (c.type === OPENAI_BLOCK.IMAGE_URL) {
              const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
              return { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: url, detail: c.image_url?.detail || "auto" };
            }
            if (c.type === RESPONSES_ITEM.INPUT_IMAGE) return c;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (let tcIdx = 0; tcIdx < msg.tool_calls.length; tcIdx++) {
        const tc = msg.tool_calls[tcIdx];
        const rawArgs = tc.function?.arguments;
        let argumentsStr = "{}";
        if (typeof rawArgs === "object" && rawArgs !== null) {
          try {
            const serialized = JSON.stringify(rawArgs);
            if (serialized === undefined) {
              throw new Error("Unserializable arguments (produced undefined)");
            }
            argumentsStr = serialized;
          } catch (err) {
            throw new Error(`Failed to serialize arguments for tool "${tc.function?.name || tcIdx}": ${err.message}`);
          }
        } else if (typeof rawArgs === "string") {
          argumentsStr = rawArgs;
        } else if (rawArgs !== undefined && rawArgs !== null) {
          throw new Error(`Invalid arguments type "${typeof rawArgs}" for tool "${tc.function?.name || tcIdx}"`);
        }
        const callId = resolveCallId(tc.id, `tc_${mIdx}_${tcIdx}`);
        pendingAssistantCallIds.push(callId);
        result.input.push({
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: callId,
          name: tc.function?.name || "_unknown",
          arguments: argumentsStr
        });
      }
    }

    // Convert tool results - output must be a string for Responses API
    if (msg.role === ROLE.TOOL) {
      let output = "";
      if (typeof msg.content === "string") {
        output = msg.content;
      } else if (Array.isArray(msg.content)) {
        try {
          output = msg.content.map(c => {
            if (typeof c === "string") return c;
            if (typeof c?.text === "string") return c.text;
            const s = JSON.stringify(c);
            if (s === undefined) throw new Error("Unserializable array element");
            return s;
          }).join("");
        } catch (err) {
          throw new Error(`Failed to serialize tool output: ${err.message}`);
        }
      } else if (msg.content !== undefined && msg.content !== null) {
        try {
          const serialized = JSON.stringify(msg.content);
          if (serialized === undefined) {
            throw new Error("Unserializable tool output (produced undefined)");
          }
          output = serialized;
        } catch (err) {
          throw new Error(`Failed to serialize tool output: ${err.message}`);
        }
      } else {
        output = "";
      }

      // Pair ID-less tool output with matching call ID from pending assistant calls
      const rawToolId = typeof msg.tool_call_id === "string" && msg.tool_call_id.trim() ? msg.tool_call_id.trim() : null;
      let callId = rawToolId ? resolveCallId(rawToolId, `tool_${mIdx}`) : null;
      if (callId) {
        const pendingIdx = pendingAssistantCallIds.indexOf(callId);
        if (pendingIdx !== -1) pendingAssistantCallIds.splice(pendingIdx, 1);
      } else {
        callId = pendingAssistantCallIds.shift() || resolveCallId(null, `tool_${mIdx}`);
      }
      result.input.push({
        type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
        call_id: callId,
        output
      });
    }
  }

  // Combine initial contiguous instructions
  result.instructions = initialInstructions.join("\n\n");

  // Convert tools format
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === OPENAI_BLOCK.FUNCTION) {
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: tool.function.name,
          description: String(tool.function.description || ""),
          parameters: normalizeToolParameters(tool.function.parameters),
          strict: tool.function.strict
        };
      }
      return tool;
    });
  }

  // Pass through validated tool_choice (fail closed on invalid values)
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === "string") {
      const allowed = new Set(["none", "auto", "required"]);
      if (allowed.has(body.tool_choice)) {
        result.tool_choice = body.tool_choice;
      } else {
        throw new Error(`Invalid tool_choice string value: "${body.tool_choice}"`);
      }
    } else if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
      if (body.tool_choice.type === "function") {
        const rawName = body.tool_choice.function?.name || body.tool_choice.name;
        const name = typeof rawName === "string" ? rawName.trim().slice(0, 128) : "";
        const toolDeclared = Array.isArray(result.tools) && result.tools.some(t => t.name === name || t.function?.name === name);
        if (!name || !toolDeclared) {
          throw new Error(`Invalid tool_choice: function "${name || 'unknown'}" is not declared in tools`);
        }
        result.tool_choice = { type: "function", name };
      } else {
        throw new Error(`Invalid tool_choice object type: "${body.tool_choice.type}"`);
      }
    } else {
      throw new Error(`Invalid tool_choice type: ${typeof body.tool_choice}`);
    }
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.reasoning !== undefined) result.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  if (body.service_tier !== undefined) result.service_tier = body.service_tier;
  if (body.prompt_cache_key !== undefined) result.prompt_cache_key = body.prompt_cache_key;

  return result;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);
