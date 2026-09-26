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
 * 2. Builds a sanitizedName -> originalName map.
 * 3. Restores original tool names across all response formats (OpenAI, Claude, Responses API).
 */

export const OPENCODE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
export const OPENCODE_TOOL_NAME_INVALID_CHARS = /[^a-zA-Z0-9_.-]/g;
export const OPENCODE_TOOL_NAME_MAX_LEN = 64;

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
 *
 * @param {object} body - Request body
 * @returns {Map<string, string>} sanitizedName -> originalName map
 */
export function sanitizeOpencodeTools(body) {
  const map = new Map();
  if (!body || typeof body !== "object") return map;

  const reverseMap = new Map(); // originalName -> sanitizedName
  const usedNames = new Set();

  // 1. Sanitize tools array
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
      const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
      const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
      if (!rawName) continue;

      if (OPENCODE_TOOL_NAME_PATTERN.test(rawName)) {
        usedNames.add(rawName);
        continue;
      }

      if (!reverseMap.has(rawName)) {
        const sanitized = sanitizeToolName(rawName, usedNames);
        map.set(sanitized, rawName);
        reverseMap.set(rawName, sanitized);
      }
      const sanitizedName = reverseMap.get(rawName);
      if (fn && typeof fn.name === "string") {
        fn.name = sanitizedName;
      }
      if (typeof tool.name === "string") {
        tool.name = sanitizedName;
      }
    }
  }

  // 2. Sanitize tool_choice if named
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    const fn = body.tool_choice.function;
    if (fn && typeof fn === "object" && typeof fn.name === "string" && reverseMap.has(fn.name)) {
      fn.name = reverseMap.get(fn.name);
    }
    if (typeof body.tool_choice.name === "string" && reverseMap.has(body.tool_choice.name)) {
      body.tool_choice.name = reverseMap.get(body.tool_choice.name);
    }
  }

  // 3. Sanitize tool calls in messages (history turns)
  if (Array.isArray(body.messages) && reverseMap.size > 0) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      if (typeof msg.name === "string" && reverseMap.has(msg.name)) {
        msg.name = reverseMap.get(msg.name);
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function && typeof tc.function.name === "string" && reverseMap.has(tc.function.name)) {
            tc.function.name = reverseMap.get(tc.function.name);
          }
        }
      }
    }
  }

  // 4. Sanitize input items (Responses API)
  if (Array.isArray(body.input) && reverseMap.size > 0) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if ((item.type === "function_call" || item.type === "function_call_output") && typeof item.name === "string" && reverseMap.has(item.name)) {
        item.name = reverseMap.get(item.name);
      }
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
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
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
