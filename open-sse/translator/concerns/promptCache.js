/**
 * Concern: Upstream Prompt Caching Injection
 * Auto-injects prompt caching controls (e.g., Anthropic cache_control: { type: "ephemeral", ttl: "1h" })
 * and normalizes prompt prefixes for OpenAI/Gemini/Codex to maximize upstream KV cache hits.
 */

import { lastCacheableToolIndex } from "../formats/claude.js";

const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
const ALLOWED_CACHE_TYPES = new Set(["text", "image", "tool_use", "tool_result"]);

/**
 * Auto-inject prompt caching attributes based on the target format and provider capabilities.
 * @param {object} body - Request body (in target format)
 * @param {string} targetFormat - Target format ("claude", "openai", "openai-responses", "gemini", etc.)
 * @returns {boolean} True if caching controls were injected
 */
export function injectPromptCaching(body, targetFormat) {
  if (!body || typeof body !== "object") return false;

  if (targetFormat === "claude") {
    return injectClaudePromptCache(body);
  }

  if (targetFormat === "openai" || targetFormat === "openai-responses") {
    return normalizeOpenAIPrefix(body);
  }

  return false;
}

/**
 * Count existing cache_control breakpoints in a Claude-format body
 * @param {object} body
 * @returns {number}
 */
function countExistingBreakpoints(body) {
  let count = 0;

  if (Array.isArray(body.system)) {
    count += body.system.filter(b => b && typeof b === "object" && b.cache_control).length;
  } else if (body.system && typeof body.system === "object" && body.system.cache_control) {
    count++;
  }

  if (Array.isArray(body.tools)) {
    count += body.tools.filter(t => t && typeof t === "object" && t.cache_control).length;
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg?.content)) {
        count += msg.content.filter(b => b && typeof b === "object" && b.cache_control).length;
      }
    }
  }

  return count;
}

/**
 * Inject cache_control breakpoints into Claude request body up to 4 breakpoints.
 * Priority: 1. system prompt, 2. tools definition, 3. conversation history.
 */
function injectClaudePromptCache(body) {
  // Always strip cache_control from defer_loading tools first (#3567)
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.defer_loading === true && tool.cache_control) {
        delete tool.cache_control;
      }
    }
  }

  let currentBreakpoints = countExistingBreakpoints(body);
  if (currentBreakpoints >= MAX_ANTHROPIC_CACHE_BREAKPOINTS) return false;

  let injected = false;
  const cacheControlPayload = { type: "ephemeral", ttl: "1h" };

  // 1. Inject in system prompt
  if (body.system && currentBreakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    if (typeof body.system === "string" && body.system.trim().length > 0) {
      body.system = [
        {
          type: "text",
          text: body.system,
          cache_control: cacheControlPayload
        }
      ];
      currentBreakpoints++;
      injected = true;
    } else if (Array.isArray(body.system) && body.system.length > 0) {
      const lastIdx = body.system.length - 1;
      const lastSys = body.system[lastIdx];
      if (typeof lastSys === "string") {
        body.system[lastIdx] = {
          type: "text",
          text: lastSys,
          cache_control: cacheControlPayload
        };
        currentBreakpoints++;
        injected = true;
      } else if (lastSys && typeof lastSys === "object" && !lastSys.cache_control) {
        lastSys.cache_control = cacheControlPayload;
        currentBreakpoints++;
        injected = true;
      }
    }
  }

  // 2. Inject in tools definition (on the last cache-eligible tool, skipping defer_loading tools)
  if (Array.isArray(body.tools) && body.tools.length > 0 && currentBreakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    const lastIdx = lastCacheableToolIndex(body.tools);
    if (lastIdx >= 0) {
      const lastTool = body.tools[lastIdx];
      if (lastTool && typeof lastTool === "object" && !lastTool.cache_control) {
        lastTool.cache_control = cacheControlPayload;
        currentBreakpoints++;
        injected = true;
      }
    }
  }

  // 3. Inject in conversation history (last valid non-thinking user/assistant content block before trailing turn)
  if (Array.isArray(body.messages) && body.messages.length >= 4 && currentBreakpoints < MAX_ANTHROPIC_CACHE_BREAKPOINTS) {
    // Scan backwards from second-to-last message for a turn with eligible content
    for (let i = body.messages.length - 2; i >= 1; i--) {
      const msg = body.messages[i];
      if (!msg) continue;

      if (typeof msg.content === "string" && msg.content.length > 0) {
        msg.content = [
          {
            type: "text",
            text: msg.content,
            cache_control: cacheControlPayload
          }
        ];
        currentBreakpoints++;
        injected = true;
        break;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        // Find last part that is in ALLOWED_CACHE_TYPES and does not already have cache_control
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const part = msg.content[j];
          if (!part || typeof part !== "object") continue;
          if (part.type && !ALLOWED_CACHE_TYPES.has(part.type)) continue;

          if (!part.cache_control) {
            part.cache_control = cacheControlPayload;
            currentBreakpoints++;
            injected = true;
            break;
          }
        }
        if (injected) break;
      }
    }
  }

  return injected;
}

/**
 * Normalize system message & tools for OpenAI/Codex (messages or input) to ensure static prefix matching
 */
function normalizeOpenAIPrefix(body) {
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;

  if (Array.isArray(items) && items.length > 1) {
    const sysIdx = items.findIndex(m => m && (m.role === "system" || m.role === "developer" || m.type === "system"));
    if (sysIdx > 0) {
      const [sysMsg] = items.splice(sysIdx, 1);
      items.unshift(sysMsg);
      return true;
    }
  }
  return false;
}
