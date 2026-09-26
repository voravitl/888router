/**
 * OpenCode & OpenAI Console Tool Name Sanitizer and Roundtrip Mapper.
 *
 * OpenCode Zen / Console enforces that function and tool names match ^[a-zA-Z0-9_.-]+$.
 * Clients such as OpenCode CLI, MCP servers, and custom plugins often send tool names
 * containing ":" (e.g. "code-review:code-review", "git:status") or other invalid characters,
 * resulting in HTTP 400 invalid_request_error:
 *   "Error from provider (Console): `name` must match ^[a-zA-Z0-9_.-]+$"
 *
 * This module:
 * 1. Sanitizes tool names in request bodies (tools, tool_choice, messages history, responses input items)
 *    by replacing any invalid character with "_" and deduplicating collisions.
 * 2. Builds a sanitizedName -> originalName map without mutating original input objects.
 * 3. Restores original tool names across all response formats (OpenAI, Claude, Responses API).
 * 4. Preserves idempotency during request retries and downstream re-transformation.
 */

export const OPENCODE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const OPENCODE_TOOL_NAME_INVALID_CHARS = /[^a-zA-Z0-9_.-]/g;
export const OPENCODE_TOOL_NAME_MAX_LEN = 64;
export const ORIGINAL_TOOL_NAME = Symbol.for("888router.originalToolName");

/**
 * Sanitizes a single tool/function name.
 * Replaces any character not in [a-zA-Z0-9_.-] with "_".
 * Ensures unique candidate names if there are collisions.
 *
 * @param {string} rawName
 * @param {Set<string>} usedNames
 * @returns {string} Sanitized name
 */
export function sanitizeToolName(rawName, usedNames = new Set()) {
  if (typeof rawName !== "string" || !rawName.trim()) return "";
  const trimmed = rawName.trim();
  let candidate = trimmed;
  if (!OPENCODE_TOOL_NAME_PATTERN.test(trimmed)) {
    let cleaned = trimmed.replace(OPENCODE_TOOL_NAME_INVALID_CHARS, "_");
    if (!cleaned) cleaned = "_tool";
    candidate = cleaned.slice(0, OPENCODE_TOOL_NAME_MAX_LEN);
  }
  const base = candidate;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, OPENCODE_TOOL_NAME_MAX_LEN - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Sanitizes tools, tool_choice, messages history, and input items in a request body.
 * Builds and returns a Map of sanitizedName -> originalName for response restoration.
 * Clones modified objects to preserve idempotency and avoid mutating caller objects.
 *
 * @param {object} body - Request body
 * @returns {Map<string, string>} sanitizedName -> originalName map
 */
export function sanitizeOpencodeTools(body) {
  const map = new Map();
  if (!body || typeof body !== "object") return map;

  const reverseMap = new Map(); // originalName -> sanitizedName
  const usedNames = new Set();

  // Pre-pass: register all naturally valid tool names to prevent collision
  // when an invalid tool name (e.g. foo:bar) is sanitized into foo_bar.
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
      const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
      const originalName = tool[ORIGINAL_TOOL_NAME] || fn?.[ORIGINAL_TOOL_NAME];
      const rawName = originalName || (typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : ""));
      if (rawName && !originalName && OPENCODE_TOOL_NAME_PATTERN.test(rawName)) {
        usedNames.add(rawName);
      }
    }
  }

  // 1. Sanitize tools array without in-place mutation of existing objects
  if (Array.isArray(body.tools)) {
    let toolsChanged = false;
    const nextTools = body.tools.map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
      const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
      const originalName = tool[ORIGINAL_TOOL_NAME] || fn?.[ORIGINAL_TOOL_NAME];
      const rawName = originalName || (typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : ""));
      if (!rawName) return tool;

      // Already clean and not a previously sanitized alias
      if (!originalName && OPENCODE_TOOL_NAME_PATTERN.test(rawName)) {
        usedNames.add(rawName);
        return tool;
      }

      if (!reverseMap.has(rawName)) {
        const sanitized = sanitizeToolName(rawName, usedNames);
        map.set(sanitized, rawName);
        reverseMap.set(rawName, sanitized);
      }
      const sanitizedName = reverseMap.get(rawName);
      toolsChanged = true;

      const nextTool = { ...tool, [ORIGINAL_TOOL_NAME]: rawName };
      if (typeof tool.name === "string") {
        nextTool.name = sanitizedName;
      }
      if (fn) {
        nextTool.function = { ...fn, name: sanitizedName, [ORIGINAL_TOOL_NAME]: rawName };
      }
      return nextTool;
    });

    if (toolsChanged) {
      body.tools = nextTools;
    }
  }

  // 2. Sanitize tool_choice if named (non-mutating)
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice) && reverseMap.size > 0) {
    let choiceChanged = false;
    const nextChoice = { ...body.tool_choice };
    const fn = body.tool_choice.function;
    const fnOrig = fn?.[ORIGINAL_TOOL_NAME] || fn?.name;
    if (fn && typeof fn === "object" && typeof fnOrig === "string" && reverseMap.has(fnOrig)) {
      nextChoice.function = { ...fn, name: reverseMap.get(fnOrig), [ORIGINAL_TOOL_NAME]: fnOrig };
      choiceChanged = true;
    }
    const choiceOrig = body.tool_choice[ORIGINAL_TOOL_NAME] || body.tool_choice.name;
    if (typeof choiceOrig === "string" && reverseMap.has(choiceOrig)) {
      nextChoice.name = reverseMap.get(choiceOrig);
      nextChoice[ORIGINAL_TOOL_NAME] = choiceOrig;
      choiceChanged = true;
    }
    if (choiceChanged) {
      body.tool_choice = nextChoice;
    }
  }

  // 3. Sanitize tool calls in messages (history turns) - non-mutating
  if (Array.isArray(body.messages) && reverseMap.size > 0) {
    let messagesChanged = false;
    const nextMessages = body.messages.map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      let msgChanged = false;
      let nextMsg = msg;

      const msgOrig = msg[ORIGINAL_TOOL_NAME] || msg.name;
      if (typeof msgOrig === "string" && reverseMap.has(msgOrig)) {
        nextMsg = { ...msg, name: reverseMap.get(msgOrig), [ORIGINAL_TOOL_NAME]: msgOrig };
        msgChanged = true;
      }

      if (Array.isArray(msg.tool_calls)) {
        let callsChanged = false;
        const nextCalls = msg.tool_calls.map((tc) => {
          const fnName = tc?.function?.[ORIGINAL_TOOL_NAME] || tc?.function?.name;
          if (typeof fnName === "string" && reverseMap.has(fnName)) {
            callsChanged = true;
            return {
              ...tc,
              function: {
                ...tc.function,
                name: reverseMap.get(fnName),
                [ORIGINAL_TOOL_NAME]: fnName,
              },
            };
          }
          return tc;
        });
        if (callsChanged) {
          if (nextMsg === msg) nextMsg = { ...msg };
          nextMsg.tool_calls = nextCalls;
          msgChanged = true;
        }
      }

      if (msgChanged) {
        messagesChanged = true;
        return nextMsg;
      }
      return msg;
    });

    if (messagesChanged) {
      body.messages = nextMessages;
    }
  }

  // 4. Sanitize input items (Responses API) - non-mutating
  if (Array.isArray(body.input) && reverseMap.size > 0) {
    let inputChanged = false;
    const nextInput = body.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const itemOrig = item[ORIGINAL_TOOL_NAME] || item.name;
      if ((item.type === "function_call" || item.type === "function_call_output") && typeof itemOrig === "string" && reverseMap.has(itemOrig)) {
        inputChanged = true;
        return {
          ...item,
          name: reverseMap.get(itemOrig),
          [ORIGINAL_TOOL_NAME]: itemOrig,
        };
      }
      return item;
    });

    if (inputChanged) {
      body.input = nextInput;
    }
  }

  return map;
}

/**
 * Restores original tool names across all response formats (Claude, OpenAI, Responses API).
 *
 * @param {any} payload - Response object or chunk
 * @param {Map<string, string>} map - sanitizedName -> originalName map
 * @returns {any} Restored payload
 */
export function restoreOpencodeToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreOpencodeToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block
    ));
  }

  // OpenAI Chat Completions (delta and message shapes)
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      if (!choice || typeof choice !== "object") return choice;
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item
    ));
  }

  // OpenAI Responses SSE item events (output_item.added / output_item.done)
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
