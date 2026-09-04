// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { matchPattern } from "./pricing.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|openai-low-high-max|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|minimax|hunyuan|step
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

// Strip a trailing thinking suffix "model(value)" so lookups resolve the base id.
function stripThinkingSuffix(model) {
  if (typeof model !== "string") return model;
  return model.replace(/\([^()]+\)\s*$/, "").trim();
}

// Scoped in-memory dynamic capabilities cache (additive, does not replace the
// legacy bare-key cache). Keys are `providerId:modelId` — matches the DB row
// key in `syncedModelsRepo.capabilityKey()` — so a synced `vision: true` on
// provider A cannot bleed into the same bare id on provider B (review finding
// #5: PR #292 lesson). Read path consults scoped first, then bare legacy.
const DYNAMIC_CAPABILITIES_CACHE_SCOPED = new Map();

// Upper sanity bound for a single model's context window. Anything above this
// is almost certainly a corrupt or over-optimistic upstream value (current
// largest public model sits at 1M-2M).
const MAX_CONTEXT_WINDOW = 10_000_000;

// Cap on per-key length. An attacker or sloppy feed could otherwise forge an
// unbounded cache key, slow the Map's hash, or fill log lines with newlines
// that masquerade as separate events (review round-2 #M5).
const MAX_KEY_SEGMENT_LENGTH = 256;

// Allowlist of capability keys the dynamic cache is permitted to surface.
// Anything else (id, providerId, createdAt, etc.) is repo metadata that must
// not leak into the capability resolver's return value (review round-2 #H3).
const CAPABILITY_KEYS = new Set([
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "search",
  "reasoning",
  "agentic",
  "thinkingFormat",
  "contextWindow",
  "maxOutput",
  "toolUse",
]);

function sanitizeSegment(s) {
  if (typeof s !== "string") return "";
  if (s.length > MAX_KEY_SEGMENT_LENGTH) {
    return s.slice(0, MAX_KEY_SEGMENT_LENGTH) + "…";
  }
  // Strip control characters that could forge log lines.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "?");
}

// Track which (providerId:modelId) keys we've already logged a rejection
// for, so a single corrupt upstream row doesn't flood the logs (review
// round-2 #M6). Cleared on `resetScopedDynamicCache()`.
const _loggedRejections = new Set();

// The scoped cache key. Mirrors `syncedModelsRepo.capabilityKey()` semantics:
// the provider-qualified form is `${providerId}:${baseModel}` where
// `baseModel` is the last `/`-separated segment of the modelId. We store BOTH
// the full-id form AND the base-id form so reads can be tried in either
// shape — review round-2 #C1 + #C2 (round-trip symmetry).
//
// Cache stores TWO entries per write:
//   1. `${providerId}:${modelId}`        (full id — round-2 review form)
//   2. `${providerId}:${baseModel}`      (base id — repo-key parity)
//
// Read path tries base-id first (matches repo), then falls back to full-id.
// Without this dual write, an upstream like "meta-llama/Llama-3.1-70B" would
// be stored under one key but the reader would look up the other, missing
// every such record.
function scopedCacheKeys(providerId, modelId) {
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  const baseModel = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  const p = sanitizeSegment(providerId);
  const fullId = `${p}:${sanitizeSegment(modelId)}`;
  const baseId = `${p}:${sanitizeSegment(baseModel)}`;
  return fullId === baseId ? { primary: fullId, aliases: [] } : { primary: baseId, aliases: [fullId] };
}

function coerceContextWindow(value) {
  // DB drivers (SQLite bigint, Postgres int8) often return numeric values as
  // strings. Coerce, then validate the range.
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (typeof value === "number") return value;
  return NaN;
}

function coerceBool(value) {
  // Reject truthy non-booleans like `"false"` (string) or `1` (number).
  if (typeof value === "boolean") return value;
  return undefined;
}

// Register dynamic capabilities for a (provider, model) pair. Idempotent;
// overwrites prior value. Returns true on success, false on rejection.
export function registerDynamicCapabilitiesScoped(providerId, modelId, caps) {
  const keys = scopedCacheKeys(providerId, modelId);
  if (!keys) return false;
  if (!caps || typeof caps !== "object") return false;

  // Build the allowlisted capability surface (review round-2 #H3).
  const clean = {};
  for (const k of CAPABILITY_KEYS) {
    if (!(k in caps)) continue;
    const v = caps[k];
    if (v === undefined || v === null) continue;
    if (k === "contextWindow") {
      const cw = coerceContextWindow(v);
      if (!Number.isFinite(cw) || cw <= 0 || cw > MAX_CONTEXT_WINDOW) {
        const logKey = `${providerId}:${modelId}`;
        if (!_loggedRejections.has(logKey)) {
          _loggedRejections.add(logKey);
          console.warn(
            `[capabilities] rejected dynamic caps for ${sanitizeSegment(providerId)}/${sanitizeSegment(modelId)}: contextWindow=${sanitizeSegment(String(v))} (max ${MAX_CONTEXT_WINDOW})`
          );
        }
        return false;
      }
      clean.contextWindow = cw;
    } else if (k === "vision" || k === "reasoning" || k === "pdf" ||
               k === "audioInput" || k === "videoInput" || k === "search" ||
               k === "agentic") {
      const b = coerceBool(v);
      if (b !== undefined) clean[k] = b;
    } else if (k === "toolUse") {
      // Accept only boolean or string enum ("claude", "openai", "kiro", "google").
      if (typeof v === "boolean") clean[k] = v;
      else if (typeof v === "string") clean[k] = v;
    } else {
      clean[k] = v;
    }
  }

  // Shallow-clone so the caller's reference can't mutate the cached object.
  const stored = { ...clean };
  DYNAMIC_CAPABILITIES_CACHE_SCOPED.set(keys.primary, stored);
  for (const alias of keys.aliases) {
    DYNAMIC_CAPABILITIES_CACHE_SCOPED.set(alias, stored);
  }
  return true;
}

// Snapshot of the scoped cache for callers that need to enumerate it.
// Returns a shallow copy of the live Map so the caller can iterate freely
// without exposing the internal cache to bypass writers (review round-3 #M1).
// For O(N) writes (e.g. re-hydration in virtualFactory), prefer `getDynamicCapabilitiesEntries()`.
// Cost is one Map copy per call — typical N~200 keys, negligible.
export function getDynamicCapabilitiesSnapshot() {
  return new Map(DYNAMIC_CAPABILITIES_CACHE_SCOPED);
}

// Live accessor for the scoped cache. Read-only by convention — callers must
// not write to the Map directly; use registerDynamicCapabilitiesScoped
// instead. Exported so producers can hand a stable, identity-stable
// reference to the auto-combo factory (review round-5 #10).
export function getScopedDynamicCapabilities() {
  return DYNAMIC_CAPABILITIES_CACHE_SCOPED;
}

// Read-only check used by tests and debug tooling.
export function hasDynamicCapabilitiesSnapshot() {
  return DYNAMIC_CAPABILITIES_CACHE_SCOPED.size > 0;
}

// Reset the cache and rejection log. Used by tests.
export function __resetScopedDynamicCache() {
  DYNAMIC_CAPABILITIES_CACHE_SCOPED.clear();
  _loggedRejections.clear();
}

// OpenCode Ox Alpha Free — image input + always-thinking reasoning
// (models.dev reasoning_options [low, high, max]; videoInput stays false until
// the common video transport is end-to-end). Shared by the provider/id pairs
// below; never exposed globally so other providers' same-named models keep
// pattern/default caps.
const OX_ALPHA_CAPABILITIES = {
  vision: true,
  reasoning: true,
  thinkingFormat: "openai-low-high-max",
  thinkingCanDisable: false,
  contextWindow: 1000000,
  maxOutput: 131072,
};

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // GLM-5.2 has 1M context (overrides *glm-5* pattern's 200k). Claude 4.6/4.7/4.8 and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  "glm-5.2":           { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-fable-5-1": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },
  "claude-fable-5.1": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  // kr/auto = Krutrim auto-router (routes to best available model; safe floor = 1M)
  "auto": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },

  // 9router's own Claude-backed aliases. They carry no "claude" substring, so no
  // PATTERN below can match them — without these exact entries /v1/models omits
  // the limits and clients fall through to their own fallback default (#275).
  "9-opus":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "9-sonnet": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "9-haiku":  { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 },
  "9-free":   { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
  "auto/best-free-1m": { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
  "auto/free-1m":      { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
};

/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
export const PROVIDER_CAPABILITIES = {
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m2.7": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 },
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-pro": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-ai/deepseek-v4-flash": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
  },
  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). `onlyReasoning` models can't turn thinking
  // off → thinkingCanDisable:false (clamped to minimal instead of disabled).
  "codebuddy-cn": {
    // GLM-5.2 is natively 1M (z.ai direct), but the CodeBuddy/Tencent gateway
    // caps the forwarded context at ~200k. Advertise the cap the gateway
    // actually honours so /v1/models matches runtime (issue #21).
    "glm-5.2":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.1":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0-turbo":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 38000 },
    "glm-4.7":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 48000 },
    "minimax-m2.7":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    // hy3/hy3-x: 256K official (192K conservative, matches hy3-preview); hy4-preview: 1M official.
    // glm-5.3: 1M (GLM-5.x gen); glm-5.3-flash window unverified (200K conservative).
    "hy3":                { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "hy3-x":              { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "hy4-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "hy4-preview-x":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "glm-5.3":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.3-flash":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k3-1":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "deepseek-v4-pro":    { vision: false, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v4-flash":  { vision: false, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
  },
  // Ollama Cloud context windows (https://ollama.com/library/<model>).
  // Per-provider overrides sit above the generic *glm-5* (200k) / *nemotron-3*
  // (128k) / *gpt-oss* (128k) catalogue patterns. Each entry below is the
  // cloud context — local Ollama contexts can be lower (e.g. 192k for
  // minimax-m2.7:q3) but the gateway always sends to cloud, so advertise cloud.
  "ollama": {
    "glm-5.3-flash":   { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1000000, maxOutput: 131072 },
    "glm-5.3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1000000, maxOutput: 131072 },
    "glm-5.1":         { reasoning: true,        thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 200000,  maxOutput: 128000 },
    "kimi-k3":         { reasoning: true,        thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 1000000, maxOutput: 131072 },
    "kimi-k2.7":       { reasoning: true,        thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 256000,  maxOutput: 64000 },
    "kimi-k2.6":       { reasoning: true,        thinkingFormat: "openai", thinkingCanDisable: true,  contextWindow: 256000,  maxOutput: 64000 },
    "qwen3.5:397b":    { reasoning: true,        thinkingFormat: "qwen",  thinkingCanDisable: true,  contextWindow: 1000000, maxOutput: 65536 },
    "qwen3.5":         { reasoning: true,        thinkingFormat: "qwen",  thinkingCanDisable: true,  contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-v4-pro":         { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-flash":       { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-flash:0731":  { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
    "minimax-m3":       { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 512000 },
    "minimax-m2.7":     { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 200000,  maxOutput: 131072 },
    "mistral-large-3:675b": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 256000, maxOutput: 64000 },
    "gpt-oss:120b":     { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 128000,  maxOutput: 64000 },
    "gpt-oss:20b":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 128000,  maxOutput: 64000 },
    "nemotron-3-ultra": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000 },
    "nemotron-3-super": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 256000,  maxOutput: 64000 },
    "gemma4:31b":       { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 128000, maxOutput: 64000 },
  },
  "opencode": {
    "x-preview-f-free": OX_ALPHA_CAPABILITIES,
    "laguna-s-2.1-free":  { reasoning: true, vision: false, contextWindow: 256000, maxOutput: 32000 },
    "ling-3.0-flash-fin-free": { reasoning: true, vision: false, contextWindow: 262144, maxOutput: 32768 },
    "muse-spark-1.2-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
    "muse-spark-1.3-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
  },
  "oc": {
    "x-preview-f-free": OX_ALPHA_CAPABILITIES,
    "muse-spark-1.2-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
    "muse-spark-1.3-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
  },
  "opencode-go": {
    "ox-alpha-free": OX_ALPHA_CAPABILITIES,
    "laguna-s-2.1-free":  { reasoning: true, vision: false, contextWindow: 256000, maxOutput: 32000 },
    "ling-3.0-flash-fin-free": { reasoning: true, vision: false, contextWindow: 262144, maxOutput: 32768 },
    "muse-spark-1.2-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
    "muse-spark-1.3-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
  },
  "ocg": {
    "ox-alpha-free": OX_ALPHA_CAPABILITIES,
  },
  "opencode-zen": {
    "x-preview-f-free": OX_ALPHA_CAPABILITIES,
    "laguna-s-2.1-free":  { reasoning: true, vision: false, contextWindow: 256000, maxOutput: 32000 },
    "ling-3.0-flash-fin-free": { reasoning: true, vision: false, contextWindow: 262144, maxOutput: 32768 },
    "muse-spark-1.2-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
    "muse-spark-1.3-contributor-free": { vision: false, pdf: false, audioInput: false, videoInput: false },
  },
  "openrouter": {
    "stealth/ox-alpha": OX_ALPHA_CAPABILITIES,
    "ox-alpha": OX_ALPHA_CAPABILITIES,
  },
  "nousresearch": {
    "stealth/ox-alpha": OX_ALPHA_CAPABILITIES,
    "ox-alpha": OX_ALPHA_CAPABILITIES,
  },
  "nous": {
    "stealth/ox-alpha": OX_ALPHA_CAPABILITIES,
    "ox-alpha": OX_ALPHA_CAPABILITIES,
  },
};

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.5+ / 4.6+ = adaptive thinking 1M; older/3.5/haiku = budget 200k) ──
  { pattern: "*claude-3.5*",        caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude-3-5*",        caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude-3-opus*",     caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude-3-sonnet*",   caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude-3-haiku*",    caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude*opus-4.5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 } },
  { pattern: "*claude*opus-4-5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 } },
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-5*",     caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4-6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4-7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4-8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-4.5*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 200000 } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true, contextWindow: 200000 } },
  { pattern: "*claude*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-5.x / Codex (1,050,000 for 5.4+; 872k for reserve; 128k for spark) ─
  { pattern: "*gpt-reserve*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 872000, maxOutput: 128000 } },
  { pattern: "*codex-auto-review*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 872000, maxOutput: 128000 } },
  { pattern: "*gpt-5*spark*",         caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 128000, maxOutput: 128000 } },
  { pattern: "*gpt-5*image*",         caps: { imageOutput: true } },
  { pattern: "*gpt-5.4-mini*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4-nano*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.5*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.6*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.7*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.8*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.9*",             caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-6*",               caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5*codex*",         caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",               caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  // Order: specific versions before *grok-4* (otherwise grok-4.5 matched 256k).
  // Official xAI docs (2026-07): grok-4.5 context window = 500,000 tokens.
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-4.6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000 } },
  { pattern: "*grok-4-6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000 } },
  { pattern: "*grok-4.5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000 } },
  { pattern: "*grok-4-5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000 } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  { pattern: "*qwen*max*",      caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (K3 = 1M/vision; K2.7-code cannot disable; K2.x = 262K) ──
  { pattern: "*kimi*k3*",        caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*",          caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  // GLM-5.2 = 1M context. Match both "glm-5.2" (z.ai) and dash/date-suffixed
  // variants ("glm-5-2-260617" on BytePlus/bpm) — exact MODEL_CAPABILITIES key
  // only catches the dot form, so glob both before the generic *glm-5* 200k.
  // NOTE: these mirror the *glm-5* family caps (zai/128k output) — only the
  // contextWindow differs from the 200k fallback. The exact `glm-5.2` entry
  // above (line ~75) is z.ai-specific (openai/48k) and still wins for the dot
  // form via exact-match precedence; these patterns serve other providers.
  { pattern: "*glm-5.2*",        caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5-2*",        caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; v4 = 1M ctx, TEXT-ONLY) ──
  // DeepSeek V4 (flash/pro) is text-only per models.dev (input=["text"]). Do NOT
  // set vision:true here — it would let image_url blocks through to upstream,
  // which rejects them with 400 "unknown variant image_url, expected text".
  // Exception: *-flash-vision* (e.g. B.AI deepseek-v4-flash-vision-exp) is a
  // documented vision SKU — must match BEFORE the text-only *deepseek-v4* glob.
  { pattern: "*deepseek-v4-flash-vision*", caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*deepseek-v4*",   caps: { vision: false, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax-m2.7*",  caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision, 1M / 262K ctx) ──────────────────────────
  { pattern: "*mimo*v2.5*",     caps: { vision: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Others ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  { pattern: "*nemotron-3-ultra*", caps: { reasoning: true, vision: false, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*nemotron*",      caps: { reasoning: true, vision: false, contextWindow: 128000 } },
  // Nous Hermes 4 (Portal live catalog 2026-08-23: 131k, text-only, reasoning param)
  { pattern: "*hermes-4*",      caps: { reasoning: true, vision: false, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*deephermes-4*",  caps: { reasoning: true, vision: false, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*laguna-s*",      caps: { reasoning: true, vision: false, contextWindow: 1048576, maxOutput: 32768 } },
  { pattern: "*muse-spark*",    caps: { reasoning: true, thinkingFormat: "openai", vision: false, pdf: false, audioInput: false, videoInput: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*big-pickle*",    caps: { contextWindow: 128000 } },
];

/**
 * Dynamic Capabilities Store (In-Memory Cache)
 * Populated at runtime from DB (syncedModelsRepo) or provider sync handlers.
 */
export const DYNAMIC_CAPABILITIES_CACHE = new Map();

export function registerDynamicCapabilities(modelId, caps) {
  if (!modelId || !caps) return;
  const baseId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  // Apply the same bounds the scoped writer enforces (review round-2 #M2).
  // Without this, a corrupt contextWindow in the legacy bare cache could
  // override the static table at read time.
  const clean = { ...caps };
  if ("contextWindow" in clean) {
    const cw = coerceContextWindow(clean.contextWindow);
    if (!Number.isFinite(cw) || cw <= 0 || cw > MAX_CONTEXT_WINDOW) {
      clean.contextWindow = undefined;
    } else {
      clean.contextWindow = cw;
    }
  }
  DYNAMIC_CAPABILITIES_CACHE.set(baseId, clean);
}

/**
 * Dynamically resolves capabilities for OpenAI GPT / Codex family models.
 * Future-proof: calculates context window, output limits, and capabilities
 * based on architectural generation and variant rules, avoiding hardcoded model lists.
 *
 * Rules:
 * - GPT-5.4+ (5.4, 5.5, 5.6, 5.7, ..., GPT-6, etc.): 1,050,000 context, 128,000 max output
 *   - Mini / Nano variants in 5.4/5.5: 400,000 context (5.6+ Luna: 1,050,000 context)
 *   - Spark variants (-spark): 128,000 context, 128,000 max output, vision: false
 *   - Codex code models: vision: false
 *   - Image variants (-image): imageOutput: true, tools: false
 * - GPT-Reserve / Codex Auto Review: 872,000 context, 128,000 max output
 * - GPT-5.0 - 5.3: 400,000 context (Spark: 128,000 context)
 * - GPT-4.1: 1,000,000 context, 32,768 max output
 * - GPT-4o: 128,000 context, vision: true, search: true, maxOutput: 16384
 * - GPT-4-turbo: 128,000 context, vision: true
 * - GPT-4 (classic): 128,000 context, vision: false
 *
 * Strips provider prefixes and -review variants automatically.
 *
 * @param {string} modelId
 * @returns {object|null} capabilities delta or null if not a GPT model
 */
export function resolveGptFamilyCapabilities(modelId) {
  if (!modelId || typeof modelId !== "string") return null;

  // 1. Normalize ID: remove thinking suffix, slash prefix
  let id = stripThinkingSuffix(modelId).toLowerCase();
  if (id.includes("/")) id = id.split("/").pop();

  // 2. Handle Codex-specific special models without version numbers
  if (id.startsWith("gpt-reserve") || id.startsWith("codex-auto-review") || id.startsWith("codex-auto")) {
    return {
      vision: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 872000,
      maxOutput: 128000,
    };
  }

  if (id.endsWith("-review")) id = id.slice(0, -7);

  // 3. Match GPT pattern: gpt-<major>[.<minor>][<separator><subvariant>]
  // Handles: gpt-5.4, gpt-5.6-sol, gpt-5-codex, gpt-4o, gpt-6, gpt-5.3-codex-spark, etc.
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:[-_.]?([a-zA-Z0-9].*))?$/i);
  if (!match) return null;

  const maj = parseInt(match[1], 10);
  const min = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const sub = (match[3] || "").toLowerCase();

  // Image models
  if (sub.includes("image")) {
    return { imageOutput: true, tools: false };
  }

  const isSpark = /(?:^|[-_.])spark(?:$|[-_.])/i.test(sub);
  const isCodex = /(?:^|[-_.])codex(?:$|[-_.])/i.test(sub);
  const isMini = /(?:^|[-_.])mini(?:$|[-_.])/i.test(sub);
  const isNano = /(?:^|[-_.])nano(?:$|[-_.])/i.test(sub);
  const isMiniOrNano = isMini || isNano;

  // GPT-5.4+ and future generations (GPT-5.4+, GPT-6, GPT-7, ...)
  if (maj > 5 || (maj === 5 && min >= 4)) {
    if (isSpark) {
      return {
        vision: false,
        reasoning: true,
        search: true,
        thinkingFormat: "openai",
        contextWindow: 128000,
        maxOutput: 128000,
      };
    }
    if (isMiniOrNano) {
      return {
        vision: !isCodex,
        reasoning: true,
        search: true,
        thinkingFormat: "openai",
        contextWindow: 400000,
        maxOutput: 128000,
      };
    }
    return {
      vision: !isCodex,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 1050000,
      maxOutput: 128000,
    };
  }

  // GPT-5.0 to GPT-5.3
  if (maj === 5) {
    if (isSpark) {
      return {
        vision: false,
        reasoning: true,
        search: true,
        thinkingFormat: "openai",
        contextWindow: 128000,
        maxOutput: 128000,
      };
    }
    if (isMiniOrNano) {
      return {
        vision: !isCodex,
        reasoning: true,
        search: true,
        thinkingFormat: "openai",
        contextWindow: 400000,
        maxOutput: 128000,
      };
    }
    return {
      vision: !isCodex,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 400000,
      maxOutput: 128000,
    };
  }

  // GPT-4.1
  if (maj === 4 && min === 1) {
    return {
      vision: true,
      contextWindow: 1000000,
      maxOutput: 32768,
    };
  }

  // GPT-4 / 4o / 4-turbo
  if (maj === 4) {
    const is4o = /^o(-|$)/i.test(sub);
    const isTurbo = /^turbo(-|$)/i.test(sub);
    if (is4o) {
      return {
        vision: true,
        search: true,
        contextWindow: 128000,
        maxOutput: 16384,
      };
    }
    if (isTurbo) {
      return {
        vision: true,
        contextWindow: 128000,
      };
    }
    return {
      contextWindow: 128000,
    };
  }

  // GPT-3 / 3.5
  if (maj === 3) {
    return {
      contextWindow: 16385,
      maxOutput: 4096,
    };
  }

  return null;
}

/**
 * Catalogue-wide static entry for a model, ignoring provider-specific overrides.
 * Those are applied separately, LAST, because they must also outrank dynamic caps.
 */
function catalogueCapabilitiesFor(model, baseModel) {
  // 1. Canonical exact (strip vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7")
  if (MODEL_CAPABILITIES[baseModel]) return MODEL_CAPABILITIES[baseModel];
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];

  const baseWithoutReview = baseModel.endsWith("-review") ? baseModel.slice(0, -7) : null;
  if (baseWithoutReview && MODEL_CAPABILITIES[baseWithoutReview]) return MODEL_CAPABILITIES[baseWithoutReview];

  // 2. Dynamic GPT / Codex family resolution (structural & future-proof)
  const gptCaps = resolveGptFamilyCapabilities(baseModel) || resolveGptFamilyCapabilities(model);
  if (gptCaps) return gptCaps;

  // 3. Pattern match (first match wins)
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return caps;
    }
  }

  // 4. Nothing known
  return null;
}

export function getCapabilitiesForModel(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  const normalizedModel = stripThinkingSuffix(model);
  const baseModel = normalizedModel.includes("/") ? normalizedModel.split("/").pop() : normalizedModel;
  const catalogueCaps = catalogueCapabilitiesFor(normalizedModel, baseModel);
  const baseWithoutReview = baseModel.endsWith("-review") ? baseModel.slice(0, -7) : null;

  // Provider-specific overrides are applied LAST — above dynamic caps, not below.
  const providerCaps = (provider && (
    PROVIDER_CAPABILITIES[provider]?.[normalizedModel]
    || PROVIDER_CAPABILITIES[provider]?.[baseModel]
    || (baseWithoutReview ? PROVIDER_CAPABILITIES[provider]?.[baseWithoutReview] : null)
  )) || null;

  // Dynamic caps (upstream sync / DB) LAYER OVER the catalogue entry: they win on
  // the fields they carry, and leave every catalogue field the sync omitted intact.
  const hasProvider = typeof provider === "string" && provider.length > 0;
  const scopedCaps = hasProvider
    ? (DYNAMIC_CAPABILITIES_CACHE_SCOPED.get(`${provider}:${baseModel}`)
        || (baseWithoutReview ? DYNAMIC_CAPABILITIES_CACHE_SCOPED.get(`${provider}:${baseWithoutReview}`) : null)
        || DYNAMIC_CAPABILITIES_CACHE_SCOPED.get(`${provider}:${normalizedModel}`))
    : null;
  const bareCaps = DYNAMIC_CAPABILITIES_CACHE.get(baseModel)
    ?? (baseWithoutReview ? DYNAMIC_CAPABILITIES_CACHE.get(baseWithoutReview) : null)
    ?? DYNAMIC_CAPABILITIES_CACHE.get(normalizedModel);
  const dynamicCaps = (scopedCaps || bareCaps)
    ? { ...(bareCaps || {}), ...(scopedCaps || {}) }
    : null;

  if (!catalogueCaps && !dynamicCaps && !providerCaps) return { ...DEFAULT_CAPABILITIES };
  return {
    ...DEFAULT_CAPABILITIES,
    ...(catalogueCaps || {}),
    ...(dynamicCaps || {}),
    ...(providerCaps || {}),
  };
}

/**
 * Strict contextWindow resolver — returns undefined ONLY when the model is
 * genuinely unknown (would hit the step-4 DEFAULT floor). Returns the real
 * contextWindow (including a legitimate 200000) for any matched entry in
 * PROVIDER / MODEL / PATTERN. Used by callers that must distinguish "unknown"
 * from "known but small" — e.g. a combo MIN must not fabricate a floor value
 * for an unknown member, but must honour a real 200k member.
 */
export function resolveKnownContextWindow(provider, model) {
  if (!model) return undefined;
  const normalizedModel = stripThinkingSuffix(model);
  const baseModel = normalizedModel.includes("/") ? normalizedModel.split("/").pop() : normalizedModel;
  const baseWithoutReview = baseModel.endsWith("-review") ? baseModel.slice(0, -7) : null;

  const providerEntry = provider && (
    PROVIDER_CAPABILITIES[provider]?.[normalizedModel]
    || PROVIDER_CAPABILITIES[provider]?.[baseModel]
    || (baseWithoutReview ? PROVIDER_CAPABILITIES[provider]?.[baseWithoutReview] : null)
  );
  if (providerEntry) {
    return providerEntry.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow;
  }

  // Scoped dynamic runtime/DB caps take precedence over bare-key legacy so
  // cross-provider bleed is impossible.
  const hasProvider = typeof provider === "string" && provider.length > 0;
  const scopedDyn = hasProvider && (
    DYNAMIC_CAPABILITIES_CACHE_SCOPED.get(`${provider}:${baseModel}`)
    || (baseWithoutReview ? DYNAMIC_CAPABILITIES_CACHE_SCOPED.get(`${provider}:${baseWithoutReview}`) : null)
  );
  const bareDyn = DYNAMIC_CAPABILITIES_CACHE.get(baseModel)
    ?? (baseWithoutReview ? DYNAMIC_CAPABILITIES_CACHE.get(baseWithoutReview) : null)
    ?? DYNAMIC_CAPABILITIES_CACHE.get(normalizedModel);
  const dyn = (scopedDyn || bareDyn)
    ? { ...(bareDyn || {}), ...(scopedDyn || {}) }
    : null;
  if (dyn && dyn.contextWindow != null) {
    const cw = coerceContextWindow(dyn.contextWindow);
    if (Number.isFinite(cw) && cw > 0 && cw <= MAX_CONTEXT_WINDOW) {
      return cw;
    }
  }

  const exact = MODEL_CAPABILITIES[baseModel]
    || MODEL_CAPABILITIES[normalizedModel]
    || (baseWithoutReview ? MODEL_CAPABILITIES[baseWithoutReview] : null);
  if (exact) return exact.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow;

  const gptCaps = resolveGptFamilyCapabilities(baseModel) || resolveGptFamilyCapabilities(normalizedModel);
  if (gptCaps?.contextWindow) return gptCaps.contextWindow;

  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, normalizedModel)) {
      return caps.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow;
    }
  }
  return undefined; // step-4 floor → genuinely unknown
}
