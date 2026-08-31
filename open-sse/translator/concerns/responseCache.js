import { createHash } from "crypto";

/**
 * Concern: Response Caching Layer (Exact SHA-256 Key)
 * Replays exact Q&A prompts for deterministic requests when opt-in header (x-888-response-cache: true) is present.
 * DEFAULT OFF for agent connections to prevent state loop issues.
 */

const MAX_CACHE_ENTRIES = 500;
const MAX_PAYLOAD_BYTES = 500 * 1024; // 500 KB max payload size per entry
const DEFAULT_TTL_MS = 3600 * 1000; // 1 hour TTL

// In-Memory LRU Cache Map: key -> { response, createdAt }
const cacheStore = new Map();

/**
 * Case-insensitive header lookup
 */
function getHeader(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  // Direct match
  if (typeof headers[lower] === "string") return headers[lower];
  // Node Headers object
  if (typeof headers.get === "function") return headers.get(name) || headers.get(lower) || "";
  // Raw object with original casing
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return String(headers[key]);
  }
  return "";
}

/**
 * Generate SHA-256 cache key from comprehensive request fingerprint
 */
/**
 * Classify the request shape so structurally-different responses don't
 * collide under the cross-model cache (issue #354). `plain` = standard
 * text completion, `tool` = function-calling or tool_use outputs,
 * `structured` = response_format / JSON-schema. Anything that mixes
 * modes falls back to `structured` (the most specific bucket).
 */
function classifyCacheShape(body) {
  if (!body || typeof body !== "object") return "plain";
  if (Array.isArray(body.tools) && body.tools.length > 0) return "tool";
  if (body.tool_choice && body.tool_choice !== "none") return "tool";
  if (body.response_format) return "structured";
  return "plain";
}

export function computeResponseCacheKey(body, model) {
  if (!body || typeof body !== "object") return null;

  try {
    // Cache key deliberately omits the `model` segment. Two requests with
    // identical content but different model ids are treated as the same
    // cache entry — the gateway cannot cache-control which upstream
    // provider actually serves the response, and users A/B-ing the same
    // prompts across Claude / GPT / Gemini hit the same upstream KV
    // cache (or the cached upstream response) instead of re-fetching
    // identical content. Issue #354.
    //
    // `cacheClass` is appended to keep plain text completions from
    // colliding with tool-calling or structured-output responses, so
    // structurally-different shapes still get distinct cache keys.
    const messages = body.messages || body.input || body.contents || [];
    const system = body.system || "";
    // Gemini uses systemInstruction
    const systemInstruction = body.systemInstruction
      ? (typeof body.systemInstruction === "string" ? body.systemInstruction : JSON.stringify(body.systemInstruction))
      : "";
    const tools = body.tools || [];
    const temp = body.temperature ?? "";
    const topP = body.top_p ?? "";
    const topK = body.top_k ?? "";
    const maxTokens = body.max_tokens ?? body.maxTokens ?? "";
    const n = body.n ?? "";
    const stop = body.stop ? JSON.stringify(body.stop) : "";
    const presencePenalty = body.presence_penalty ?? "";
    const frequencyPenalty = body.frequency_penalty ?? "";
    const seed = body.seed ?? "";
    const user = body.user ?? "";
    const logprobs = body.logprobs ?? "";
    const fmt = body.response_format ? JSON.stringify(body.response_format) : "";
    const cacheClass = classifyCacheShape(body);

    const rawString = `${cacheClass}:${JSON.stringify(messages)}:${JSON.stringify(system)}:${systemInstruction}:${JSON.stringify(tools)}:${temp}:${topP}:${topK}:${maxTokens}:${n}:${stop}:${presencePenalty}:${frequencyPenalty}:${seed}:${user}:${logprobs}:${fmt}`;
    return createHash("sha256").update(rawString).digest("hex");
  } catch (e) {
    console.warn("[ResponseCache] computeResponseCacheKey failed:", e.message);
    return null;
  }
}

/**
 * Check if response caching is opt-in via headers only (STRICT CONTRACT)
 */
export function isResponseCacheOptIn(body, headers = {}) {
  const cacheHeader = getHeader(headers, "x-888-response-cache") || getHeader(headers, "x-cache-response");
  return cacheHeader === "true" || cacheHeader === "1";
}

/**
 * Safety check: refuse caching when streaming, tools, or tool_calls are involved
 */
export function isCacheablePayload(body, response = null) {
  if (!body || typeof body !== "object") return false;

  // Refuse streaming requests
  if (body.stream === true) return false;

  // Refuse tool-using requests (agent loops)
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (body.tool_choice && body.tool_choice !== "none") return false;

  // If inspecting response: refuse tool_calls outputs
  if (response && typeof response === "object") {
    if (Array.isArray(response.choices)) {
      const hasToolCalls = response.choices.some(c => c?.message?.tool_calls || c?.delta?.tool_calls);
      if (hasToolCalls) return false;
    }
  }

  return true;
}

/**
 * Retrieve cached response if present and valid (not expired)
 * Returns { cachedResponse, hit, cacheKey } or null
 */
export function getCachedResponse(body, model, headers = {}) {
  if (!isResponseCacheOptIn(body, headers)) return null;
  if (!isCacheablePayload(body)) return null;

  const key = computeResponseCacheKey(body, model);
  if (!key || !cacheStore.has(key)) return null;

  const entry = cacheStore.get(key);
  const now = Date.now();

  // Expire entry if TTL exceeded
  if (now - entry.createdAt > DEFAULT_TTL_MS) {
    cacheStore.delete(key);
    return null;
  }

  // Refresh LRU order on hit (delete + re-set)
  cacheStore.delete(key);
  cacheStore.set(key, entry);

  try {
    return {
      cachedResponse: JSON.parse(JSON.stringify(entry.response)), // Deep clone output
      hit: true,
      cacheKey: key
    };
  } catch {
    return null;
  }
}

/**
 * Store response in cache (LRU eviction if max size or byte cap reached)
 */
export function setCachedResponse(body, model, response, headers = {}) {
  if (!isResponseCacheOptIn(body, headers)) return false;
  if (!isCacheablePayload(body, response)) return false;

  const key = computeResponseCacheKey(body, model);
  if (!key) return false;

  let serialized = "";
  try {
    serialized = JSON.stringify(response);
    if (!serialized) return false;
    // Use byte length, not char length, for accurate size enforcement
    if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) return false;
  } catch {
    return false;
  }

  // Update existing key or evict oldest if at capacity
  if (cacheStore.has(key)) {
    cacheStore.delete(key);
  } else if (cacheStore.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cacheStore.keys().next().value;
    if (oldestKey) cacheStore.delete(oldestKey);
  }

  try {
    cacheStore.set(key, {
      response: JSON.parse(serialized), // Deep clone input
      createdAt: Date.now()
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear cache (convenience helper for testing)
 */
export function clearResponseCache() {
  cacheStore.clear();
}
