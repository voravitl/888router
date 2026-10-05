/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter, getUnavailableUntil } from "./accountFallback.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { createComboStreamGuard } from "./comboStreamGuard.js";
import { getContextFit, estimateRequestTokens } from "./requestContext.js";
import { getRequestTimeoutPolicy } from "../utils/requestTimeout.js";
import { getPricingForModel } from "../providers/pricing.js";
import { resolveProviderAlias } from "./model.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Reasoning models (deepseek, kimi, etc.) can burn the whole max_tokens budget on
// the thinking phase and return content: "" with finish_reason: "length". When that
// happens we retry once with a raised budget. Pure function, exported for tests.
export function isReasoningEmptyContent(finishReason, content, reasoningContent) {
  return (
    (finishReason === "length" || finishReason === "max_tokens") &&
    !content &&
    !!(reasoningContent || "").length
  );
}

// Does a parsed 200 body carry a usable answer? Spans every client format this
// router serves — OpenAI (`choices`), Claude messages (`content`), Gemini
// (`candidates`), OpenAI Responses (`output`) — so a Claude/Gemini answer that
// also carries a non-fatal `error`/warning field is not mistaken for a pure
// error envelope. Pure function, exported for tests.
export function hasUsableCompletionPayload(completion) {
  if (!completion || typeof completion !== "object") return false;
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.length > 0 : !!v);
  return (
    nonEmpty(completion.choices) ||
    nonEmpty(completion.content) ||
    nonEmpty(completion.candidates) ||
    nonEmpty(completion.output) ||
    nonEmpty(completion.output_text)
  );
}

// Coerce a candidate status into an HTTP FAILURE status, or null when it is not
// one. Used for `lastStatus`, which describes why the combo gave up and is handed
// straight to `new Response` on the all-models-failed path.
//
// Two traps this closes:
//  - Provider error `code`s are not HTTP statuses. kilo-gateway sends 502, but
//    others send proprietary integers (10004) or strings ("rate_limit"). Anything
//    outside 200-599 makes `new Response` throw RangeError, dropping the
//    connection instead of returning an error body.
//  - A 2xx must never become the failure status. The failing shapes this file
//    detects (embedded error envelope, empty body, zero-text stream) all arrive
//    WITH a 2xx status, so adopting it verbatim served a failure to the client as
//    a success — a caller checking only the status code would treat the error
//    envelope as an answer. Only 400-599 is accepted; callers fall back to 502.
//
// Pure function, exported for tests.
export function toHttpFailureStatus(code) {
  const n = typeof code === "string" ? Number(code) : code;
  if (!Number.isInteger(n) || n < 400 || n > 599) return null;
  return n;
}

// Raise max_tokens for the retry: original x3 or +512 (whichever is larger), minimum 2048, capped
// at 65536. Returns a new body object, never mutates the original.
function withRaisedMaxTokens(body) {
  const original = Number.isFinite(body?.max_tokens) ? body.max_tokens : 0;
  const raised = Math.min(Math.max(original * 3, original + 512, 2048), 65536);
  return { ...body, max_tokens: raised };
}

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  const tiers = models.map((m, i) => ({ m, i, t: tierOf(m) }));
  if (tiers.every((x) => x.t === tiers[0].t)) return models;

  return tiers
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
    else if (mime === "application/pdf" || mime.endsWith("/pdf")) required.add("pdf");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") required.add("pdf");
    // gemini parts: inlineData/fileData carry a mime
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType;
    if (mime) addByMime(mime);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // Search capability from tools
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t?.type === "web_search" || t?.type === "search" || t?.function?.name === "web_search") {
        required.add("search");
      }
    }
  }

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Compute stable hash of prefix (system instructions + tools) for cache-optimized pinning
 * @param {object} body - Request body
 * @returns {number} 32-bit positive integer hash
 */
export function computePrefixHash(body) {
  if (!body) return 0;
  let prefix = "";
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && (m.role === "system" || m.role === "developer")) {
        prefix += (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")) + "\n";
      }
    }
    if (!prefix && body.messages[0]) {
      const first = body.messages[0];
      prefix += (typeof first?.content === "string" ? first.content : JSON.stringify(first?.content || "")) + "\n";
    }
  }
  if (Array.isArray(body.tools)) {
    prefix += JSON.stringify(body.tools);
  }
  // Clamp to first 2,048 chars (Normalized Substring) to avoid excessive processing
  prefix = prefix.slice(0, 2048);
  if (!prefix) return 0;
  
  // Fast FNV-1a 32-bit hash
  let hash = 2166136261;
  for (let i = 0; i < prefix.length; i++) {
    hash ^= prefix.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

/**
 * Resolve one model string to its quota reading, for the `headroom` selector.
 * Provider comes from model parsing (`ag/model` → antigravity via the alias
 * map); each provider then contributes its best (max) snapshot across ACTIVE
 * connections, so one exhausted account does not drag down a provider that
 * still has a healthy account. Fail-open everywhere: unknown providers, a
 * throwing reader, or no connections all yield null (→ score 0 → list order).
 * A snapshot with no (or unparseable) checkedAt is treated as STALE — a
 * reading that can never age out would otherwise pin the selector to dead
 * data forever.
 */
export async function readComboQuotaForModel(modelStr, getConnections, { maxAgeMs = 60 * 60 * 1000 } = {}) {
  try {
    const prefix = String(modelStr).includes("/")
      ? String(modelStr).slice(0, String(modelStr).indexOf("/"))
      : "";
    const provider = resolveProviderAlias(prefix) || prefix;
    if (!provider || typeof getConnections !== "function") return null;

    const connections = await getConnections({ provider, isActive: true });
    const now = Date.now();
    let best = null;
    for (const c of connections || []) {
      const pct = Number.isFinite(c?.quotaRemainingPct) ? c.quotaRemainingPct : null;
      if (pct == null) continue;
      const checkedAt = c?.quotaCheckedAt ? Date.parse(c.quotaCheckedAt) : NaN;
      if (!Number.isFinite(checkedAt) || now - checkedAt > maxAgeMs) continue;
      if (best == null || pct > best.pct) {
        best = { pct, checkedAt: c.quotaCheckedAt, connectionId: c.id };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Batch quota resolution for a candidate list, grouped by provider so each
 * distinct provider costs exactly one `getConnections` call no matter how many
 * of its models sit in the combo. Returns `{ quotaByModel }` shaped for
 * `orderByHeadroom` via `ctx`. Fail-open: a throwing reader yields `{}`.
 */
export async function readComboQuotaByModel(models, getConnections, opts = {}) {
  try {
    if (typeof getConnections !== "function") return {};
    const byProvider = new Map();
    for (const m of models || []) {
      const prefix = String(m).includes("/") ? String(m).slice(0, String(m).indexOf("/")) : "";
      const provider = resolveProviderAlias(prefix) || prefix;
      if (!provider) continue;
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(m);
    }
    const quotaByModel = {};
    await Promise.all([...byProvider.entries()].map(async ([provider, members]) => {
      const connections = await getConnections({ provider, isActive: true });
      const now = Date.now();
      const maxAgeMs = opts.maxAgeMs ?? 60 * 60 * 1000;
      let best = null;
      for (const c of connections || []) {
        const pct = Number.isFinite(c?.quotaRemainingPct) ? c.quotaRemainingPct : null;
        if (pct == null) continue;
        const checkedAt = c?.quotaCheckedAt ? Date.parse(c.quotaCheckedAt) : NaN;
        if (!Number.isFinite(checkedAt) || now - checkedAt > maxAgeMs) continue;
        if (best == null || pct > best.pct) {
          best = { pct, checkedAt: c.quotaCheckedAt, connectionId: c.id };
        }
      }
      if (best) for (const m of members) quotaByModel[m] = best;
    }));
    return quotaByModel;
  } catch {
    return {};
  }
}

/**
 * Selector for `headroom`: rank candidates by remaining provider quota, best
 * (most headroom) first. Candidate readings arrive via `ctx.quotaByModel`
 * (populated by handleComboChat through readComboQuotaForModel, or by tests
 * directly) so the selector itself stays pure, synchronous and never opens the
 * DB. Fail-open: any missing / stale / unreadable reading scores as "unknown"
 * (0) and ties break by list order, so a combo with no quota data simply runs
 * list order.
 */
function orderByHeadroom(models, ctx) {
  const readings = ctx?.quotaByModel || {};
  const maxAgeMs = ctx?.quotaMaxAgeMs ?? 60 * 60 * 1000;
  const now = ctx?.now ?? Date.now();

  const scoreOf = (m) => {
    const r = readings[m];
    if (!r) return 0;
    const pct = Number.isFinite(r.pct) ? r.pct : null;
    const checkedAt = r.checkedAt ? Date.parse(r.checkedAt) : NaN;
    if (pct == null) return 0;
    // A stale snapshot is as good as no snapshot — never rank on it.
    if (Number.isFinite(checkedAt) && now - checkedAt > maxAgeMs) return 0;
    return pct;
  };

  return models
    .map((m, i) => ({ m, i, s: scoreOf(m) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Selector for `cost-optimized`: static per-model price lookup, cheapest first.
 * Unknown-priced models score as most-expensive rather than cheapest, so a
 * missing pricing entry never steers traffic to an unpriced model. Fail-open:
 * a pricing lookup error leaves list order intact.
 */
function orderByCost(models) {
  const blendedCost = (m) => {
    const pricing = getPricingForModel(m);
    if (!pricing) return Number.POSITIVE_INFINITY;
    const input = Number.isFinite(pricing.input) ? pricing.input : 0;
    const output = Number.isFinite(pricing.output) ? pricing.output : 0;
    return input + output;
  };
  return models
    .map((m, i) => ({ m, i, c: blendedCost(m) }))
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Selector for `least-used`: order by the in-flight request counter maintained
 * by markComboInflight / clearComboInflight around each candidate attempt.
 * Counter reads come from `ctx.inflightByModel` when supplied (tests) and the
 * process-local map otherwise. Fail-open: ties and missing counters break by
 * list order, and a read error leaves list order untouched.
 */
function orderByLeastUsed(models, ctx) {
  const counts = ctx?.inflightByModel || comboInFlight;
  const loadOf = (m) => {
    const n = Number(counts.get ? counts.get(m) : counts[m]);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return models
    .map((m, i) => ({ m, i, n: loadOf(m) }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.m);
}

/**
 * In-memory in-flight counters for the `least-used` selector: incremented when
 * a combo candidate attempt starts, decremented when it settles (success,
 * failure, or skip). Process-local by design — the same tradeoff as
 * comboHeadTimeoutCooldowns, and no DB read on the hot path. Exported helpers
 * exist for tests.
 */
const comboInFlight = new Map();

/** Start (or restart) the in-flight attempt count for `modelStr`. */
export function markComboInflight(modelStr) {
  comboInFlight.set(modelStr, (comboInFlight.get(modelStr) || 0) + 1);
}

/** Settle the in-flight attempt count for `modelStr` (never goes negative). */
export function clearComboInflight(modelStr) {
  const current = comboInFlight.get(modelStr) || 0;
  if (current <= 1) comboInFlight.delete(modelStr);
  else comboInFlight.set(modelStr, current - 1);
}

/** Current in-flight attempt count for `modelStr`. */
export function getComboInflight(modelStr) {
  return comboInFlight.get(modelStr) || 0;
}

/** Clear one or all in-flight counters. Exported for tests. */
export function clearComboInFlightCounters(modelStr) {
  if (modelStr) comboInFlight.delete(modelStr);
  else comboInFlight.clear();
}

/**
 * The rotation selectors, keyed by strategy id. Adding a strategy means adding
 * an entry here — the UI's selectable set, ACTIVE_STRATEGY_IDS and this
 * registry stay in lockstep via the parity tests.
 *
 * `fusion` is absent by design: handleFusionChat dispatches it before this
 * ever runs (see src/sse/handlers/chat.js).
 */
const strategyRegistry = {
  // Plain list order — the default and the redirect target.
  fallback: (models) => models,

  "round-robin": (models, { comboName, stickyLimit }) => {
    const rotationKey = comboName || "__default__";
    const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
    const existingState = comboRotationState.get(rotationKey);
    const state = typeof existingState === "number"
      ? { index: existingState, consecutiveUseCount: 0 }
      : (existingState || { index: 0, consecutiveUseCount: 0 });

    const currentIndex = state.index % models.length;
    const rotatedModels = rotateModelsFromIndex(models, currentIndex);
    const nextUseCount = state.consecutiveUseCount + 1;

    if (nextUseCount >= normalizedStickyLimit) {
      comboRotationState.set(rotationKey, {
        index: (currentIndex + 1) % models.length,
        consecutiveUseCount: 0,
      });
    } else {
      comboRotationState.set(rotationKey, {
        index: currentIndex,
        consecutiveUseCount: nextUseCount,
      });
    }

    return rotatedModels;
  },

  // Pins the same prompt prefix/instructions to the same model index.
  "cache-optimized": (models, { body }) => (body
    ? rotateModelsFromIndex(models, computePrefixHash(body) % models.length)
    : models),

  // Power-of-Two-Choices (p2c): samples two candidates, starts from the first.
  p2c: (models) => {
    const idxA = Math.floor(Math.random() * models.length);
    const idxB = Math.floor(Math.random() * models.length);
    return rotateModelsFromIndex(models, Math.min(idxA, idxB));
  },

  // 5-minute wall-clock slot rotation. `reset-aware` and `reset-window` are the
  // same engine behaviour under two names (both selectable in the dashboard).
  "reset-aware": (models) => rotateModelsFromIndex(models, resetSlotIndex(models)),
  "reset-window": (models) => rotateModelsFromIndex(models, resetSlotIndex(models)),

  headroom: orderByHeadroom,
  "cost-optimized": orderByCost,
  "least-used": orderByLeastUsed,

  // Uniform, stateless per-request pick (no head bias, unlike p2c).
  random: (models) => rotateModelsFromIndex(models, Math.floor(Math.random() * models.length)),
};

/** 5-minute slot → starting index. Extracted so both reset aliases share it. */
function resetSlotIndex(models) {
  const timeSlot = Math.floor(Date.now() / (5 * 60 * 1000));
  return timeSlot % models.length;
}

/**
 * Strategy names getRotatedModels() actually implements. Anything else is
 * normalized to `fallback` — see normalizePersistedStrategy.
 * `fusion` is handled by handleFusionChat (never reaches here).
 */
export const COMBO_ROTATION_STRATEGIES = new Set(Object.keys(strategyRegistry));

/**
 * Redirect table for retired/renamed strategy strings. Kept per-string (not a
 * blanket "anything unknown → fallback" only) so a legacy alias can be mapped
 * to a real selector later. Empty today; unknown strings still fall back.
 */
const strategyRedirects = {};

/** Count of strategies redirected by normalization this process (log visibility). */
let strategyRedirectCount = 0;

/** Redirect count since process start (or the last clear). Exposed for tests. */
export function getComboStrategyRedirectCount() {
  return strategyRedirectCount;
}

/** Reset the redirect counter. Test seam only. */
export function clearComboStrategyRedirectCount() {
  strategyRedirectCount = 0;
}

// Names already warned about, so a misconfigured combo logs once per process
// instead of once per request.
const warnedUnknownStrategies = new Set();

/** Clear the unknown-strategy warn-once state. Test seam only. */
export function clearComboUnknownStrategyWarnings() {
  warnedUnknownStrategies.clear();
}

/**
 * The single choke point that turns a persisted strategy string into an
 * effective one. Unknown / retired strings are redirected (per-strategy map
 * first, then `fallback`) and warned once per process, so a stale value can
 * never again degrade silently while telemetry reports the string as-is.
 *
 * Fail-open by contract: this never throws and never returns null — an
 * unusable input yields `fallback`, which is always implemented.
 *
 * @param {string|null|undefined} strategy - Raw persisted value
 * @param {string} [comboName] - For the warn-once message
 * @returns {string} An implemented strategy id
 */
export function normalizePersistedStrategy(strategy, comboName = "") {
  if (strategy == null || strategy === "") return "fallback";
  const raw = String(strategy);
  if (COMBO_ROTATION_STRATEGIES.has(raw)) return raw;
  // `fusion` is dispatched upstream (handleFusionChat) and never reaches
  // getRotatedModels, so it must survive normalization untouched.
  if (raw === "fusion") return raw;

  const redirected = strategyRedirects[raw];
  if (redirected && COMBO_ROTATION_STRATEGIES.has(redirected)) {
    if (!warnedUnknownStrategies.has(raw)) {
      warnedUnknownStrategies.add(raw);
      strategyRedirectCount++;
      console.warn(`[combo] retired strategy "${raw}" on combo "${comboName || ""}" → "${redirected}"`);
    }
    return redirected;
  }

  if (!warnedUnknownStrategies.has(raw)) {
    warnedUnknownStrategies.add(raw);
    strategyRedirectCount++;
    console.warn(`[combo] unknown strategy "${raw}" on combo "${comboName || ""}" — using list order (fallback)`);
  }
  return "fallback";
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - Persisted strategy id (normalized before dispatch)
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @param {object} [body=null] - Request body for cache-optimized hashing
 * @param {object} [ctx={}] - Selector context (quotaByModel, inflightByModel, now)
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1, body = null, ctx = {}) {
  if (!models || models.length <= 1) {
    return models;
  }

  // Every selector is fail-open: an unexpected throw inside one leaves the
  // candidate list untouched (plain list order) instead of failing the request.
  try {
    const selector = strategyRegistry[normalizePersistedStrategy(strategy, comboName)];
    return selector(models, { comboName, stickyLimit, body, ...ctx });
  } catch {
    return models;
  }
}

/**
 * Attach X-Router-Decision telemetry header to Response
 * @param {Response} response - Original fetch Response
 * @param {object} meta - Decision metadata
 * @returns {Response}
 */
export function attachRouterDecisionHeader(response, meta = {}) {
  if (!response || !response.headers) return response;
  try {
    const strategy = meta.strategy || "fallback";
    const model = meta.model || "unknown";
    const fallbackCount = meta.fallbackCount ?? 0;
    const status = meta.status || (response.ok ? "ok" : "error");
    let headerVal = `strategy=${strategy}; model=${model}; fallback_count=${fallbackCount}; status=${status}`;
    if (meta.savingsTokens !== undefined && meta.savingsTokens !== null) {
      headerVal += `; savings_tokens=${meta.savingsTokens}`;
    }
    const headers = new Headers(response.headers);
    headers.set("X-Router-Decision", headerVal);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
/**
 * Cancel a stream body or reader with an absolute 300ms bound and sync-exception safety
 * @param {ReadableStream|ReadableStreamDefaultReader|object} target
 */
export async function safeCancelStream(target) {
  if (!target || typeof target.cancel !== "function") return;
  let timer;
  try {
    const cancelPromise = Promise.resolve().then(() => target.cancel());
    cancelPromise.catch(() => {});
    await Promise.race([
      cancelPromise,
      new Promise(resolve => { timer = setTimeout(resolve, 300); })
    ]);
  } catch {} finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap a ReadableStream to propagate cancellation/abort to upstream and clean up listeners on completion
 * @param {ReadableStream} stream
 * @param {Function} [onDone]
 * @param {Function} [onCancel]
 * @returns {ReadableStream}
 */
export function attachStreamAbortCleanup(stream, onDone, onCancel) {
  if (!stream || typeof stream.getReader !== "function") {
    if (typeof onDone === "function") onDone();
    return stream;
  }
  const reader = stream.getReader();
  let doneCalled = false;
  const callDone = () => {
    if (!doneCalled) {
      doneCalled = true;
      if (typeof onDone === "function") onDone();
    }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { controller.close(); } catch {}
          callDone();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        try { controller.error(err); } catch {}
        callDone();
      }
    },
    async cancel(reason) {
      try {
        if (typeof onCancel === "function") onCancel(reason);
      } finally {
        callDone();
        await safeCancelStream(reader);
      }
    },
  });
}

/**
 * Race a promise against an AbortSignal so client abort immediately rejects without waiting for uncooperative executors
 * @param {Promise<any>} promise
 * @param {AbortSignal|null} abortSignal
 * @returns {Promise<any>}
 */
export function withAbortRace(promise, abortSignal) {
  if (!abortSignal) return promise;
  let aborted = Boolean(abortSignal.aborted);
  const wrappedPromise = Promise.resolve(promise)
    .then(async (res) => {
      if (aborted && res && res.body) {
        await safeCancelStream(res.body);
      }
      return res;
    })
    .catch((err) => {
      if (aborted) {
        // losing branch rejection after abort — suppress unhandled rejection
        return;
      }
      throw err;
    });

  if (aborted) {
    const err = new Error("Request aborted by client");
    err.name = "AbortError";
    return Promise.reject(err);
  }
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => {
      aborted = true;
      const err = new Error("Request aborted by client");
      err.name = "AbortError";
      reject(err);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([
    wrappedPromise.finally(() => {
      if (onAbort) abortSignal.removeEventListener("abort", onAbort);
    }),
    abortPromise,
  ]);
}

/**
 * Wrap a selected response body with abort cleanup and upstream cancellation on downstream cancel
 * @param {Response} response
 * @param {Function} [cleanup]
 * @param {Function} [onCancel]
 * @returns {Response}
 */
export function wrapSelectedBody(response, cleanup, onCancel) {
  if (!response || !response.body || typeof response.body.getReader !== "function") {
    if (typeof cleanup === "function") cleanup();
    return response;
  }
  const wrapped = attachStreamAbortCleanup(response.body, cleanup, onCancel);
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * In-memory cooldown for models whose stream head timed out. A TTFT/stall
 * timeout means the upstream is slow, not dead — but retrying it first on the
 * NEXT request is a guaranteed repeat of the same 30s stall. Parking the model
 * briefly lets the next request start from a healthy candidate. Pure
 * process-local state (no cross-module coupling); exported helpers exist for
 * tests. Upgrade path: move to healthStore when cross-provider cooldown
 * coordination is needed.
 */
const comboHeadTimeoutCooldowns = new Map();
const COMBO_HEAD_TIMEOUT_COOLDOWN_MS = 30 * 1000;

/** Epoch ms until which `modelStr` is parked after a stream-head timeout, or 0. */
export function getComboHeadTimeoutCooldown(modelStr) {
  return comboHeadTimeoutCooldowns.get(modelStr) || 0;
}

/** Park `modelStr` for `ms` (default 30s). Exported for tests. */
export function markComboHeadTimeout(modelStr, ms = COMBO_HEAD_TIMEOUT_COOLDOWN_MS) {
  comboHeadTimeoutCooldowns.set(modelStr, Date.now() + ms);
}

/** Clear one or all head-timeout cooldowns. Exported for tests. */
export function clearComboHeadTimeoutCooldown(modelStr) {
  if (modelStr) comboHeadTimeoutCooldowns.delete(modelStr);
  else comboHeadTimeoutCooldowns.clear();
}

/**
 * Models a combo learned are unavailable until a known time. When the combo
 * loop sees a 429/quota verdict carrying a Retry-After (header or body), it
 * records the unlock instant here so the NEXT request pre-skips that candidate
 * instead of burning 1–5s discovering the lock again. Pure process-local
 * state, same layering rationale as comboHeadTimeoutCooldowns — we deliberately
 * do not reach into accountFallback's `isModelLockActive`, which is a
 * per-account concern resolved during account selection.
 */
const comboKnownUnavailable = new Map();

/** Epoch ms until which `modelStr` is known unavailable, or 0. */
export function getComboKnownUnavailable(modelStr) {
  return comboKnownUnavailable.get(modelStr) || 0;
}

/**
 * Record that `modelStr` is unavailable until `untilEpochMs`. Non-finite or
 * already-passed instants are ignored so the map can never park a model
 * forever. Exported for tests.
 */
export function markComboKnownUnavailable(modelStr, untilEpochMs) {
  const until = Number(untilEpochMs);
  if (!Number.isFinite(until) || until <= Date.now()) return;
  comboKnownUnavailable.set(modelStr, until);
}

/** Clear one or all known-unavailable entries. Exported for tests. */
export function clearComboKnownUnavailable(modelStr) {
  if (modelStr) comboKnownUnavailable.delete(modelStr);
  else comboKnownUnavailable.clear();
}

/**
 * Retry-After for an all-failed verdict. A failed candidate that is known to be
 * unavailable until a given time (the AUTH layer's "pool parked / accounts
 * locked, reset after Ns" verdicts) says so in a Retry-After HEADER —
 * unavailableResponse() never puts it in the body — and the combo used to drop
 * it, so a client retried every ~3s against a combo that could not answer yet
 * (#517). A body `retryAfter` already routes to the 429 quota verdict.
 */
const COMBO_ALL_FAILED_RETRY_AFTER_CAP_S = 60; // the horizon clients honour

/** Epoch ms from a delta-seconds Retry-After header, or null when absent/unusable. */
export function retryAfterHeaderMs(headers, now = Date.now()) {
  const raw = headers?.get?.("retry-after");
  if (raw == null || raw === "") return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : null;
}

/**
 * Seconds to put in the all-failed verdict's Retry-After, or null when it cannot
 * be stated honestly: EVERY processed candidate must have said when it recovers,
 * otherwise an immediate retry might still land on one that did not. Floored at
 * 1s, capped at COMBO_ALL_FAILED_RETRY_AFTER_CAP_S.
 */
export function allFailedRetryAfterSeconds(resetHints, processedCount, now = Date.now()) {
  if (!processedCount || resetHints.size !== processedCount) return null;
  const earliest = Math.min(...resetHints.values());
  return Math.min(Math.max(Math.ceil((earliest - now) / 1000), 1), COMBO_ALL_FAILED_RETRY_AFTER_CAP_S);
}

function contextCapacityResponse() {
  return new Response(JSON.stringify({ error: {
    type: "invalid_request_error",
    code: "output_limit_exceeded",
    message: "The requested output budget exceeds every eligible model's declared output limit. Input was not truncated.",
  } }), { status: 400, headers: { "Content-Type": "application/json" } });
}

async function resolveCandidateRefs(models, resolveModelInfo, log) {
  const refs = new Map();
  for (const model of models) {
    if (!resolveModelInfo) { refs.set(model, model); continue; }
    try {
      const resolved = await resolveModelInfo(model);
      refs.set(model, resolved?.provider && resolved?.model ? resolved : { provider: null, model: null });
    } catch {
      log?.warn?.("COMBO", "Candidate metadata resolution unavailable; retaining candidate with unknown limits.");
      refs.set(model, { provider: null, model: null });
    }
  }
  return refs;
}

export async function handleComboChat({ body, models, handleSingleModel, resolveModelInfo, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, signal = null, getComboConnections = null, comboQuotaCtx = null }) {
  // Approximate token counts guide ordering; only an exact output-budget
  // violation excludes a candidate. The upstream tokenizer remains authoritative.
  const estimatedInputTokens = estimateRequestTokens(body);
  const modelRefs = await resolveCandidateRefs(models, resolveModelInfo, log);
  const fits = new Map(models.map((model) => [model, getContextFit(body, modelRefs.get(model), estimatedInputTokens)]));
  const eligibleModels = models.filter((model) => fits.get(model).reason !== "output_limit_exceeded");
  if (models.length > 0 && eligibleModels.length === 0) {
    return contextCapacityResponse();
  }
  // Apply the persisted strategy — normalized once, so every log line and the
  // X-Router-Decision header below report the strategy that actually ran, not
  // the raw persisted string. Returned responses stamp this effective value.
  const effectiveStrategy = normalizePersistedStrategy(comboStrategy, comboName);
  const redirectNote = effectiveStrategy !== comboStrategy && comboStrategy != null && comboStrategy !== ""
    ? ` (strategy "${comboStrategy}" normalized → "${effectiveStrategy}")`
    : "";
  if (redirectNote) log.warn("COMBO", `Combo "${comboName || ""}" strategy redirect (${getComboStrategyRedirectCount()} total): "${comboStrategy}" → "${effectiveStrategy}"`);
  // Headroom needs a quota reading per candidate, fetched once up front (not
  // per attempt) and keyed by exact candidate string. Reads are grouped by
  // provider (one getConnections call each), and any fetch failure leaves the
  // map empty so the selector falls back to list order. Lazily resolved
  // reader keeps the Next.js DB layer out of this module (see readComboQuotaByModel).
  let headroomCtx = comboQuotaCtx;
  if (effectiveStrategy === "headroom" && !headroomCtx && typeof getComboConnections === "function") {
    try {
      headroomCtx = { quotaByModel: await readComboQuotaByModel(eligibleModels, getComboConnections) };
    } catch {
      headroomCtx = null; // fail-open → selector sees no readings → list order
    }
  }
  let rotatedModels = getRotatedModels(eligibleModels, comboName, effectiveStrategy, comboStickyLimit, body, headroomCtx || {});
  const timeoutPolicy = getRequestTimeoutPolicy(body);

  // Combo-wide time budget: per-candidate deadlines (TTFT/stall/head) stack, so
  // N slow models × 30s each can hold one request for minutes before a 504 —
  // and the client then retries the whole combo 10 more times. The budget caps
  // total combo time; the loop breaks out to the all-models-failed path once
  // exhausted. COMBO_TOTAL_BUDGET_MS env, default 180s.
  const parseTotalBudgetMs = (val, def = 180000, min = 10000, max = 600000) => {
    if (val == null || val === "") return def;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(Math.max(Math.round(n), min), max);
  };
  const COMBO_TOTAL_BUDGET_MS = parseTotalBudgetMs(process.env.COMBO_TOTAL_BUDGET_MS, timeoutPolicy.totalBudgetMs);
  const comboStartMs = Date.now();

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  rotatedModels = rotatedModels.filter((model) => fits.get(model).reason !== "context_length_exceeded")
    .concat(rotatedModels.filter((model) => fits.get(model).reason === "context_length_exceeded"));
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  // Per processed candidate: when it says it can serve again (see allFailedRetryAfterSeconds).
  let processedCandidates = 0;
  const resetHints = new Map();

  for (let i = 0; i < rotatedModels.length; i++) {
    if (signal && signal.aborted) {
      log.warn("COMBO", `Client aborted request, terminating combo loop (${comboName || ""})`);
      return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
        status: 499,
        headers: { "Content-Type": "application/json" }
      });
    }

    const modelStr = rotatedModels[i];
    processedCandidates++;

    // Skip candidates parked by a recent stream-head timeout — retrying the
    // same slow model first is a guaranteed repeat of the same stall.
    const parkedUntil = getComboHeadTimeoutCooldown(modelStr);
    if (parkedUntil > Date.now()) {
      resetHints.set(i, parkedUntil);
      log.info("COMBO", `Skipping model ${i + 1}/${rotatedModels.length}: ${modelStr} (stream-head timeout cooldown, ${Math.ceil((parkedUntil - Date.now()) / 1000)}s left)`);
      lastError = lastError ? `${lastError}; ${modelStr} in stream-head timeout cooldown` : `${modelStr} in stream-head timeout cooldown`;
      continue;
    }

    // Skip candidates locked by a known quota/rate-limit window — attempting
    // one is a guaranteed repeat of the same 429 we already paid for. Fed from
    // the reset hints collected below; mirrors the head-timeout pre-skip above.
    const lockedUntil = getComboKnownUnavailable(modelStr);
    if (lockedUntil > Date.now()) {
      resetHints.set(i, lockedUntil);
      log.info("COMBO", `Skipping model ${i + 1}/${rotatedModels.length}: ${modelStr} (known unavailable until ${new Date(lockedUntil).toISOString()}, ${Math.ceil((lockedUntil - Date.now()) / 1000)}s left)`);
      lastError = lastError ? `${lastError}; ${modelStr} known unavailable` : `${modelStr} known unavailable`;
      continue;
    }

    // Combo-wide time budget: stop starting new candidates once exhausted so
    // one request cannot stack N × TTFT waits before returning a verdict.
    if (Date.now() - comboStartMs >= COMBO_TOTAL_BUDGET_MS) {
      log.warn("COMBO", `Combo "${comboName || ""}" exceeded total time budget (${COMBO_TOTAL_BUDGET_MS}ms) after ${i}/${rotatedModels.length} candidates`);
      lastError = lastError ? `${lastError}; combo total time budget exceeded (${COMBO_TOTAL_BUDGET_MS}ms)` : `combo total time budget exceeded (${COMBO_TOTAL_BUDGET_MS}ms)`;
      if (!lastStatus) lastStatus = 504;
      break;
    }

    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);
    // In-flight mark for the `least-used` selector on LATER requests (this
    // request's order is already fixed — only future requests read it back).
    markComboInflight(modelStr);

    const candidateAbortCtrl = new AbortController();
    const onClientAbort = () => candidateAbortCtrl.abort();
    let isCandidateSelected = false;
    let abortListenerRemoved = false;
    const removeClientAbortListener = () => {
      if (signal && !abortListenerRemoved) {
        abortListenerRemoved = true;
        signal.removeEventListener("abort", onClientAbort);
      }
    };
    if (signal) {
      if (signal.aborted) {
        candidateAbortCtrl.abort();
      } else {
        signal.addEventListener("abort", onClientAbort, { once: true });
      }
    }
    try {
      const result = await withAbortRace(
        handleSingleModel(body, modelStr, { isCombo: true, signal: candidateAbortCtrl.signal }),
        signal
      );

      if (signal?.aborted) {
        if (result?.body) await safeCancelStream(result.body);
        candidateAbortCtrl.abort();
        isCandidateSelected = true;
        removeClientAbortListener();
        return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
          status: 499,
          headers: { "Content-Type": "application/json" }
        });
      }
      
      // Success (2xx) - return response
      if (result.ok) {
        // A 2xx with no usable body (stalled upstream / empty proxy-pool stream)
        // is a failure, not a success — fall through to the next combo model
        // instead of piping an empty response to the client. Best-effort check:
        // explicit Content-Length: 0 or a null body; chunked streams have no
        // content-length header and stay on the normal path.
        const emptyBody = result.headers?.get("content-length") === "0" || result.body === null;
        if (emptyBody) {
          candidateAbortCtrl.abort();
          if (result.body) {
            await safeCancelStream(result.body);
          }
          log.warn("COMBO", `Model ${modelStr} returned ${result.status} with empty body, trying next`);
          lastError = `empty body (${result.status})`;
          if (!lastStatus) lastStatus = toHttpFailureStatus(result.status) ?? 502;
          continue;
        }
        if (!emptyBody && result.body && typeof result.body.getReader === "function") {
          const contentType = result.headers?.get("content-type") || "";
          if (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")) {
            const guard = createComboStreamGuard();
            const reader = result.body.getReader();
            const parseClampedMs = (val, def, min = 50, max = 300000) => {
              if (val == null || val === "") return def;
              const n = Number(val);
              if (!Number.isFinite(n) || n <= 0) return def;
              return Math.min(Math.max(Math.round(n), min), max);
            };
            const COMBO_TTFT_TIMEOUT_MS = parseClampedMs(process.env.COMBO_TTFT_TIMEOUT_MS, timeoutPolicy.firstChunkTimeoutMs);
            const COMBO_STALL_TIMEOUT_MS = parseClampedMs(process.env.COMBO_STALL_TIMEOUT_MS, Math.min(COMBO_TTFT_TIMEOUT_MS, timeoutPolicy.stallTimeoutMs));
            const COMBO_HEAD_DEADLINE_MS = parseClampedMs(process.env.COMBO_HEAD_DEADLINE_MS, timeoutPolicy.headDeadlineMs);
            const decisionDeadline = Date.now() + COMBO_HEAD_DEADLINE_MS;
            const TIMEOUT_SENTINEL = Symbol("COMBO_HEAD_TIMEOUT");
            let onHeadCandidateAbort;
            const abortPromise = new Promise((_, reject) => {
              onHeadCandidateAbort = () => reject(new Error("Client aborted"));
              if (candidateAbortCtrl.signal.aborted) reject(new Error("Client aborted"));
              else candidateAbortCtrl.signal.addEventListener("abort", onHeadCandidateAbort, { once: true });
            });

            let streamHeadTimedOut = false;
            let streamHeadReadError = null;
            let timedOutDurationMs = COMBO_TTFT_TIMEOUT_MS;
            let timeoutType = "TTFT";
            let receivedChunks = 0;

            const safeCancelReader = async (r) => {
              candidateAbortCtrl.abort();
              await safeCancelStream(r);
            };

            try {
              while (!guard.hasDecision()) {
              const remainingDeadlineMs = Math.max(0, decisionDeadline - Date.now());
              if (remainingDeadlineMs <= 0) {
                streamHeadTimedOut = true;
                timedOutDurationMs = COMBO_HEAD_DEADLINE_MS;
                timeoutType = "deadline";
                log.warn("COMBO", `Model ${modelStr} stream head exceeded decision deadline (${COMBO_HEAD_DEADLINE_MS}ms, chunks=${receivedChunks})`);
                break;
              }
              const currentTimeoutMs = Math.min(
                receivedChunks === 0 ? COMBO_TTFT_TIMEOUT_MS : COMBO_STALL_TIMEOUT_MS,
                remainingDeadlineMs
              );
              let timer;
              const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(TIMEOUT_SENTINEL), currentTimeoutMs);
              });
              try {
                const readPromise = reader.read();
                readPromise.catch(() => {});
                const racers = [readPromise, timeoutPromise, abortPromise];
                const { done, value } = await Promise.race(racers);
                clearTimeout(timer);
                if (done) {
                  guard.feedEnd();
                  break;
                }
                if (value && (value.byteLength || value.length) > 0) {
                  receivedChunks++;
                }
                guard.feed(value);
              } catch (err) {
                clearTimeout(timer);
                if (signal?.aborted) {
                  log.warn("COMBO", `Client aborted request during stream head read (${comboName || ""})`);
                  await safeCancelReader(reader);
                  isCandidateSelected = true;
                  removeClientAbortListener();
                  return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
                    status: 499,
                    headers: { "Content-Type": "application/json" }
                  });
                }
                if (err === TIMEOUT_SENTINEL) {
                  streamHeadTimedOut = true;
                  timedOutDurationMs = currentTimeoutMs;
                  const isDeadline = Date.now() >= decisionDeadline;
                  timeoutType = isDeadline ? "deadline" : (receivedChunks === 0 ? "TTFT" : "stall");
                  log.warn("COMBO", `Model ${modelStr} stream head timed out waiting for decision (${currentTimeoutMs}ms, chunks=${receivedChunks})`);
                } else {
                  streamHeadReadError = err?.message || String(err);
                  log.warn("COMBO", `Model ${modelStr} stream head read failed: ${streamHeadReadError}`);
                }
                break;
              }
            }
            } finally {
              if (onHeadCandidateAbort) {
                candidateAbortCtrl.signal.removeEventListener("abort", onHeadCandidateAbort);
              }
            }
            if (streamHeadTimedOut) {
              await safeCancelReader(reader);
              if (signal?.aborted) break;
              // Park the slow model so the next request starts from a healthy
              // candidate instead of repeating the same stall.
              markComboHeadTimeout(modelStr);
              lastError = `stream head ${timeoutType} timeout (${timedOutDurationMs}ms)`;
              if (!lastStatus) lastStatus = 504;
              continue;
            }
            if (streamHeadReadError) {
              await safeCancelReader(reader);
              if (signal?.aborted) break;
              lastError = "stream head read error";
              if (!lastStatus) lastStatus = 502;
              continue;
            }
            if (guard.isEmpty()) {
              // Reasoning-budget exhaustion signature: the stream carried
              // thinking (sawReasoning) and ended via finish_reason:"length"
              // with zero text — the model burned its whole max_tokens budget
              // on the reasoning phase (deepseek/kimi/opencode -free models).
              // That is a RETRY condition, not a plain empty verdict: mirror
              // the non-stream path below (isReasoningEmptyContent) and give
              // the model one more attempt with a raised budget before
              // falling through to the next combo model.
              if (guard.sawReasoning() && (guard.finishReason() === "length" || guard.finishReason() === "max_tokens")) {
                if (signal?.aborted) break;
                log.warn("COMBO", `Model ${modelStr} exhausted max_tokens on reasoning (streamed), retrying once with raised budget`);
                await safeCancelReader(reader);
                if (signal?.aborted) break;
                const raisedBody = withRaisedMaxTokens(body);
                if (getContextFit(raisedBody, modelRefs.get(modelStr)).reason === "output_limit_exceeded") {
                  lastError = "Raised reasoning output budget exceeds model capacity";
                  lastStatus = 400;
                  continue;
                }
                const retryAbortCtrl = new AbortController();
                const onRetryClientAbort = () => retryAbortCtrl.abort();
                if (signal) {
                  if (signal.aborted) retryAbortCtrl.abort();
                  else signal.addEventListener("abort", onRetryClientAbort, { once: true });
                }
                let retryAbortListenerRemoved = false;
                const cleanupRetryAbort = () => {
                  if (signal && !retryAbortListenerRemoved) {
                    retryAbortListenerRemoved = true;
                    signal.removeEventListener("abort", onRetryClientAbort);
                  }
                };
                let retried;
                try {
                  retried = await withAbortRace(
                    handleSingleModel(raisedBody, modelStr, { isCombo: true, signal: retryAbortCtrl.signal }),
                    signal
                  );
                } catch (retryErr) {
                  retryAbortCtrl.abort();
                  cleanupRetryAbort();
                  if (signal?.aborted) {
                    log.warn("COMBO", `Client aborted request during streamed reasoning retry (${comboName || ""})`);
                    isCandidateSelected = true;
                    removeClientAbortListener();
                    return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
                      status: 499,
                      headers: { "Content-Type": "application/json" }
                    });
                  }
                  throw retryErr;
                }
                if (signal?.aborted) {
                  if (retried?.body) await safeCancelStream(retried.body);
                  retryAbortCtrl.abort();
                  cleanupRetryAbort();
                  isCandidateSelected = true;
                  removeClientAbortListener();
                  return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
                    status: 499,
                    headers: { "Content-Type": "application/json" }
                  });
                }
                if (!retried.ok) {
                  retryAbortCtrl.abort();
                  if (retried.body) await safeCancelStream(retried.body);
                  cleanupRetryAbort();
                  lastError = `reasoning budget exhausted; streamed retry failed (${retried.status})`;
                  if (!lastStatus) lastStatus = toHttpFailureStatus(retried.status) ?? 502;
                  continue;
                }
                log.info("COMBO", `Model ${modelStr} succeeded after streamed reasoning-budget retry`);
                let retriedWithCleanup;
                try {
                  retriedWithCleanup = wrapSelectedBody(retried, cleanupRetryAbort, () => retryAbortCtrl.abort());
                  isCandidateSelected = true;
                  removeClientAbortListener();
                } catch (wrapErr) {
                  retryAbortCtrl.abort();
                  candidateAbortCtrl.abort();
                  if (retried.body) await safeCancelStream(retried.body);
                  cleanupRetryAbort();
                  removeClientAbortListener();
                  throw wrapErr;
                }
                return attachRouterDecisionHeader(retriedWithCleanup, { strategy: effectiveStrategy, model: modelStr, fallbackCount: i, status: "ok" });
              }
              log.warn("COMBO", `Model ${modelStr} returned ${result.status} SSE stream with zero text content, trying next`);
              await safeCancelReader(reader);
              lastError = lastError ? `${lastError}; empty stream content` : "empty stream content";
              if (!lastStatus) lastStatus = 502;
              continue;
            }
            // Release the buffered head and continue the stream to the client.
            // Drop content-length: the original value no longer matches once
            // the buffered head is prepended — a stale header truncates/hangs
            // the client.
            const streamHeaders = new Headers(result.headers);
            streamHeaders.delete("content-length");
            const responseWithHeaders = new Response(pipeStreamWithHead(
              reader,
              guard.release(),
              removeClientAbortListener,
              () => candidateAbortCtrl.abort()
            ), {
              status: result.status,
              headers: streamHeaders,
            });
            isCandidateSelected = true;
            return attachRouterDecisionHeader(responseWithHeaders, { strategy: effectiveStrategy, model: modelStr, fallbackCount: i, status: "ok" });
          }
        }
        // ponytail: reasoning models (deepseek, kimi, ...) can exhaust max_tokens
        // on the thinking phase and return content: "" with finish_reason: "length"
        // and reasoning_content filled. Retry once with a raised budget. Only the
        // non-stream (JSON body) case is handled — the stream:true SSE case needs
        // per-chunk finish_reason inspection; add when reasoning models are used
        // with streaming.
        if (result.headers?.get('content-type')?.includes('application/json')) {
          let completion = null;
          try {
            completion = await result.clone().json();
          } catch {
            // not JSON — leave completion null
          }
          // Some upstreams answer HTTP 200 while carrying the failure INSIDE the
          // body (observed: kilo-gateway/nvidia `{"error":{"message":"Upstream
          // error from Nvidia: Service temporarily overloaded","code":502}}`).
          // `result.ok` is true, so without this check the combo treated the
          // failure as a success and piped an error object to the client
          // instead of falling through to the next model.
          //
          // Only an error envelope with NO usable payload counts. The payload
          // check spans every client format this router serves, not just
          // OpenAI `choices`: a Claude (`content`) or Gemini (`candidates`)
          // response that also carries a non-fatal `error`/warning field is a
          // successful answer and must stay on the normal path.
          if (completion?.error && !hasUsableCompletionPayload(completion)) {
            const e = completion.error;
            const embedded = (typeof e === "string" ? e : e?.message) || "embedded error";
            log.warn("COMBO", `Model ${modelStr} returned ${result.status} with embedded error, trying next: ${embedded}`);
            lastError = lastError ? `${lastError}; ${embedded}` : embedded;
            // A provider error `code` is neither an HTTP status nor necessarily a
            // failure status — see toHttpFailureStatus. Anything that is not a
            // real 4xx/5xx becomes 502.
            if (!lastStatus) lastStatus = toHttpFailureStatus(e?.code) ?? 502;
            candidateAbortCtrl.abort();
            if (result.body) {
              await safeCancelStream(result.body);
            }
            continue;
          }
          const choice = completion?.choices?.[0];
          const msg = choice?.message;
          if (msg && isReasoningEmptyContent(
            choice.finish_reason,
            msg.content,
            msg.reasoning_content ?? msg.reasoning ?? msg.reasoningContent,
          )) {
            log.warn("COMBO", `Model ${modelStr} exhausted max_tokens on reasoning, retrying once with raised budget`);
            if (result.body) {
              await safeCancelStream(result.body);
            }
            const raisedBody = withRaisedMaxTokens(body);
            if (getContextFit(raisedBody, modelRefs.get(modelStr)).reason === "output_limit_exceeded") {
              lastError = "Raised reasoning output budget exceeds model capacity";
              lastStatus = 400;
              continue;
            }
            let retried;
            try {
              retried = await withAbortRace(
                handleSingleModel(raisedBody, modelStr, { isCombo: true, signal: candidateAbortCtrl.signal }),
                signal
              );
            } catch (retryErr) {
              candidateAbortCtrl.abort();
              if (signal?.aborted) {
                log.warn("COMBO", `Client aborted request during reasoning retry (${comboName || ""})`);
                isCandidateSelected = true;
                removeClientAbortListener();
                return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
                  status: 499,
                  headers: { "Content-Type": "application/json" }
                });
              }
              throw retryErr;
            }
            if (signal?.aborted) {
              if (retried?.body) await safeCancelStream(retried.body);
              candidateAbortCtrl.abort();
              isCandidateSelected = true;
              removeClientAbortListener();
              return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
                status: 499,
                headers: { "Content-Type": "application/json" }
              });
            }
            if (retried.ok) {
              log.info("COMBO", `Model ${modelStr} succeeded after reasoning-budget retry`);
              let retriedWithCleanup;
              try {
                retriedWithCleanup = wrapSelectedBody(retried, removeClientAbortListener, () => candidateAbortCtrl.abort());
                isCandidateSelected = true;
              } catch (wrapErr) {
                candidateAbortCtrl.abort();
                if (retried.body) await safeCancelStream(retried.body);
                removeClientAbortListener();
                throw wrapErr;
              }
              return attachRouterDecisionHeader(retriedWithCleanup, { strategy: effectiveStrategy, model: modelStr, fallbackCount: i, status: "ok" });
            }
            candidateAbortCtrl.abort();
            if (retried.body) await safeCancelStream(retried.body);
            lastError = `reasoning-empty-content retry failed (${retried.status})`;
            if (!lastStatus) lastStatus = toHttpFailureStatus(retried.status) ?? 502;
            continue;
          }
        }
        log.info("COMBO", `Model ${modelStr} succeeded`);
        let resultWithCleanup;
        try {
          resultWithCleanup = wrapSelectedBody(result, removeClientAbortListener, () => candidateAbortCtrl.abort());
          isCandidateSelected = true;
        } catch (wrapErr) {
          candidateAbortCtrl.abort();
          if (result.body) await safeCancelStream(result.body);
          removeClientAbortListener();
          throw wrapErr;
        }
        return attachRouterDecisionHeader(resultWithCleanup, { strategy: effectiveStrategy, model: modelStr, fallbackCount: i, status: "ok" });
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      const errContentType = result.headers?.get("content-type") || "";
      if (!errContentType || errContentType.includes("json")) {
        let timer = null;
        let errReader = null;
        try {
          if (result.body && typeof result.body.getReader === "function") {
            errReader = result.body.getReader();
            const readPromise = errReader.read().then(({ done, value }) => {
              if (done || !value) return null;
              const text = new TextDecoder().decode(value);
              try { return JSON.parse(text); } catch { return { message: text }; }
            });
            readPromise.catch(() => {});
            const timeoutPromise = new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), 300);
            });
            const errorBody = await withAbortRace(
              Promise.race([readPromise, timeoutPromise]),
              signal
            );
            errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
            retryAfter = errorBody?.retryAfter || null;
            // Google-style error envelope (antigravity/gemini-cli): the reset
            // hint lives in details[] as RetryInfo.retryDelay ("289539.38s")
            // or ErrorInfo.metadata.quotaResetTimeStamp, not in a top-level
            // retryAfter field. Without this the combo cannot distinguish an
            // 80h account quota from a per-minute RPM wall.
            if (!retryAfter && Array.isArray(errorBody?.error?.details)) {
              for (const d of errorBody.error.details) {
                const type = d?.["@type"] || "";
                if (type.includes("RetryInfo") && d.retryDelay) {
                  const secs = parseFloat(d.retryDelay);
                  if (Number.isFinite(secs) && secs > 0) { retryAfter = new Date(Date.now() + secs * 1000).toISOString(); break; }
                }
                if (type.includes("ErrorInfo") && d.metadata?.quotaResetTimeStamp) {
                  const ts = Date.parse(d.metadata.quotaResetTimeStamp);
                  if (!Number.isNaN(ts) && ts > Date.now()) { retryAfter = new Date(ts).toISOString(); break; }
                }
              }
            }
          }
        } catch {
          // not JSON, timed out, or aborted
        } finally {
          if (timer) clearTimeout(timer);
          if (errReader) await safeCancelStream(errReader);
        }
      }

      // A candidate that says when it recovers (Retry-After from unavailableResponse)
      // feeds the all-failed verdict's Retry-After — and records the lock so
      // the next request pre-skips this candidate instead of re-attempting it.
      const resetMs = retryAfterHeaderMs(result.headers);
      if (resetMs != null) {
        resetHints.set(i, resetMs);
        markComboKnownUnavailable(modelStr, resetMs);
      }

      if (signal?.aborted) {
        log.warn("COMBO", `Client aborted request during error parsing (${comboName || ""})`);
        candidateAbortCtrl.abort();
        if (result.body) await safeCancelStream(result.body);
        isCandidateSelected = true;
        removeClientAbortListener();
        return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
          status: 499,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { shouldFallback, cooldownMs, modelError } = checkFallbackError(result.status, errorText);

      // A model is quota/rate-limit limited when the upstream returned 429, or
      // when the error text is an explicit quota/rate-limit signal (even if no
      // retryAfter field came back — e.g. ollama's FreeUsageLimitError). Layer
      // below (chat.js + auth.js) has already rotated through every eligible
      // proxy pool/account before this error reached the combo loop, so a
      // quota-limited combo should STOP and return 429+retry-after rather than
      // switch to a model that shares the same exhausted quota/pool.
      const quotaLimited = result.status === 429 ||
        /rate.?limit|usage.?limit|quota|too many requests|overloaded|capacity/i.test(errorText || "");
      // Long quota windows (subscription/individual quota, "Resets in 80h…")
      // are account-level, not request-level: every remaining combo model on
      // the SAME provider shares the account, so trying them is a guaranteed
      // second 429 delivered to the client as the combo's verdict. Skip to the
      // first candidate on a different provider instead (observed: 4/5
      // ag/claude-sonnet-4-6 429 → 5/5 ag/gemini-3.8-flash-medium 429 again).
      // Short rate limits (per-minute RPM) do NOT trigger this — the next
      // model may genuinely have its own headroom.
      //
      // retryAfter here is usually NULL for antigravity: by the time the error
      // reaches the combo it has been re-wrapped by chatCore's errorResponse as
      // {"error":{"message":"[429]: … Resets in 78h1m5s."}} — the details[]
      // array is gone. The "Resets in Xh…" TEXT is the surviving hint, so parse
      // it from errorText as a fallback source for the window length.
      let longQuotaWindow = retryAfter && (new Date(retryAfter).getTime() - Date.now()) > 60_000;
      if (quotaLimited && !longQuotaWindow && errorText) {
        const text = typeof errorText === "string" ? errorText : String(errorText);
        // Hours/minutes/seconds groups are independently optional so bare
        // "Resets in 2h" / "Resets in 5m" also match; the /h/ discriminator on
        // m[0] routes hours text to the h-branch, minutes text to the m-branch.
        // "reset after" is the antigravity executor's own spelling for the
        // same hint ("Your quota will reset after 2h7m23s"); a combo error
        // string can carry either spelling depending on which layer surfaced
        // the failure first.
        const m = text.match(/Resets? in (\d+)h(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i)
          || text.match(/Resets? in (\d+)m(?:\s*(\d+(?:\.\d+)?)s)?/i)
          || text.match(/resets? after (\d+)h(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i)
          || text.match(/resets? after (\d+)m(?:\s*(\d+(?:\.\d+)?)s)?/i);
        if (m) {
          const isHours = /h/i.test(m[0]);
          const ms = isHours
            ? (parseInt(m[1], 10) * 3600 + (parseInt(m[2], 10) || 0) * 60) * 1000
            : (parseInt(m[1], 10) * 60 + Math.round(parseFloat(m[2]) || 0)) * 1000;
          if (ms > 60_000) {
            retryAfter = retryAfter || new Date(Date.now() + ms).toISOString();
            longQuotaWindow = true;
          }
        }
      }
      if (quotaLimited && longQuotaWindow) {
        const providerOf = (m) => (typeof m === "string" && m.includes("/")) ? m.slice(0, m.indexOf("/")) : m;
        const failedProvider = providerOf(modelStr);
        const nextIdx = rotatedModels.findIndex((m, j) => j > i && providerOf(m) !== failedProvider);
        const lockUntilMs = retryAfter ? new Date(retryAfter).getTime() : NaN;
        // Record the failed model AND every jumped-over same-provider candidate:
        // they share the exhausted account/quota, so the next request must
        // pre-skip all of them, not just the one that surfaced the verdict.
        if (Number.isFinite(lockUntilMs)) {
          markComboKnownUnavailable(modelStr, lockUntilMs);
          resetHints.set(i, lockUntilMs);
          for (let j = i + 1; j < (nextIdx > i ? nextIdx : rotatedModels.length); j++) {
            if (providerOf(rotatedModels[j]) === failedProvider) {
              markComboKnownUnavailable(rotatedModels[j], lockUntilMs);
              resetHints.set(j, lockUntilMs);
            }
          }
        } else if (resetMs != null) {
          resetHints.set(i, resetMs);
          markComboKnownUnavailable(modelStr, resetMs);
        }
        log.warn("COMBO", `Model ${modelStr} hit a long quota window (retry-after ${Math.round((new Date(retryAfter).getTime() - Date.now()) / 60000)}m); skipping remaining ${failedProvider} models`);
        candidateAbortCtrl.abort();
        if (result.body) await safeCancelStream(result.body);
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = toHttpFailureStatus(result.status) ?? 429;
        if (nextIdx > i) {
          i = nextIdx - 1; // for-loop's i++ lands on nextIdx
          continue;
        }
        // All remaining candidates share the provider — stop with 429 verdict.
        // Keep the MINIMUM retryAfter: an earlier different-provider model may
        // have reported a shorter window (T+30m) than this final model's 80h.
        if (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter)) {
          earliestRetryAfter = retryAfter;
        }
        break;
      }
      if (quotaLimited) {
        // Prefer an explicit retryAfter; else derive a cooldown from the
        // fallback classifier so the client gets a usable retry window.
        // Either way the lock is recorded for the next request's pre-skip.
        const lockMs = retryAfter
          ? new Date(retryAfter).getTime()
          : (cooldownMs && cooldownMs > 0 ? new Date(getUnavailableUntil(cooldownMs)).getTime() : NaN);
        if (Number.isFinite(lockMs)) markComboKnownUnavailable(modelStr, lockMs);
        if (!retryAfter && cooldownMs && cooldownMs > 0) {
          earliestRetryAfter = getUnavailableUntil(cooldownMs);
        }
      }

      if (!shouldFallback && !modelError) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        isCandidateSelected = true;
        return wrapSelectedBody(result, removeClientAbortListener, () => candidateAbortCtrl.abort());
      }

      if (modelError) {
        log.warn("COMBO", `Model ${modelStr} permanent model-error, skipping to next model`, { status: result.status });
      }

      // Fast failover: do NOT sleep in hot-path between candidates in a combo;
      // cooldown is recorded for subsequent requests, but current request immediately tries next candidate.

      // Fast failover: cancel discarded failure body and abort upstream before trying next candidate
      candidateAbortCtrl.abort();
      if (result.body) {
        await safeCancelStream(result.body);
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      // Non-2xx by construction, but a 3xx is still not a failure status the
      // client should receive as the combo's verdict — see toHttpFailureStatus.
      if (!lastStatus) lastStatus = toHttpFailureStatus(result.status) ?? 502;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      candidateAbortCtrl.abort();
      if (signal?.aborted) {
        log.warn("COMBO", `Client aborted request during combo execution (${comboName || ""})`);
        isCandidateSelected = true;
        removeClientAbortListener();
        return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), {
          status: 499,
          headers: { "Content-Type": "application/json" }
        });
      }
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    } finally {
      clearComboInflight(modelStr);
      if (!isCandidateSelected) {
        removeClientAbortListener();
      }
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  // Attach the router decision to failure verdicts too, not just successes:
  // without it a client retry ("API error · Retrying N/10" with no detail) can
  // never be correlated with the gateway reason that caused it.
  const failureMeta = { strategy: effectiveStrategy, model: "none", fallbackCount: rotatedModels.length, status: "error" };

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models quota-limited, returning 429 retry-after (${retryHuman}) | ${msg}`);
    // Quota-limited (every model hit a rate limit and layer below already
    // rotated through all proxy pools/accounts): return 429 so the client
    // retries after the reset window rather than combo switching to a model
    // that shares the same exhausted quota/pool. The layer below (chat.js +
    // auth.js) has already tried every eligible proxy pool before this 429.
    return attachRouterDecisionHeader(
      unavailableResponse(HTTP_STATUS.RATE_LIMITED, msg, earliestRetryAfter, retryHuman),
      failureMeta,
    );
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  const retryAfterSec = allFailedRetryAfterSeconds(resetHints, processedCandidates);
  return attachRouterDecisionHeader(
    new Response(
      JSON.stringify({ error: { message: msg } }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          ...(retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {}),
        },
      }
    ),
    failureMeta,
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: Number.parseInt(process.env.FUSION_HARD_TIMEOUT_MS, 10) || 30000, // absolute cap (30s) so one hung model cannot stall forever
};

// Bound candidate work and actively cancel it when its deadline expires.
function withTimeout(promise, ms, onTimeout, signal) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ __aborted: true });
    const t = setTimeout(() => { finish({ __timeout: true }); onTimeout?.(); }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise)
      .then(finish)
      .catch((e) => finish({ __error: e }));
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }, onFinish, signal) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", finish);
      onFinish?.(out);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { if (!finished) out[i] = v; })
        .catch((e) => { if (!finished) out[i] = { __error: e }; })
        .finally(() => {
          if (finished) return;
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr, isPanel, { signal }) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @param {AbortSignal} [options.signal] - External cancellation shared by panel and final requests
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, resolveModelInfo, log, comboName, judgeModel, tuning, signal = null }) {
  if (signal?.aborted) return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), { status: 499, headers: { "Content-Type": "application/json" } });
  const requestedPanel = Array.isArray(models) ? models.filter(Boolean) : [];
  const modelRefs = await resolveCandidateRefs(requestedPanel, resolveModelInfo, log);
  const panel = requestedPanel.filter((model) => getContextFit(body, modelRefs.get(model)).reason !== "output_limit_exceeded");
  if (requestedPanel.length > 0 && panel.length === 0) return contextCapacityResponse();
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0], undefined, { signal });
  }

  const timeoutPolicy = getRequestTimeoutPolicy(body);
  const configuredFusionTimeout = Number(process.env.FUSION_HARD_TIMEOUT_MS);
  const adaptivePanelTimeout = Number.isFinite(configuredFusionTimeout) && configuredFusionTimeout > 0
    ? configuredFusionTimeout
    : (timeoutPolicy.longContext ? timeoutPolicy.firstChunkTimeoutMs : FUSION_DEFAULTS.panelHardTimeoutMs);
  const cfg = { ...FUSION_DEFAULTS, panelHardTimeoutMs: adaptivePanelTimeout, ...(tuning || {}) };
  cfg.panelHardTimeoutMs = Math.min(Math.max(Number(cfg.panelHardTimeoutMs) || adaptivePanelTimeout, 50), 300000);
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const panelControllers = panel.map(() => new AbortController());
  const calls = panel.map((m, i) => {
    const controller = panelControllers[i];
    const candidateSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const work = (async () => {
      const res = await handleSingleModel(panelBody, m, true, { signal: candidateSignal });
      if (!res.ok) {
        if (res.body) await safeCancelStream(res.body);
        return res;
      }
      // Include body consumption in the panel deadline: headers alone do not
      // constitute a completed answer, and quorum cannot count a stalled body.
      const json = await res.json();
      return { ok: res.ok, status: res.status, panelText: extractPanelText(json) };
    })();
    return withTimeout(work, cfg.panelHardTimeoutMs, () => controller.abort(), candidateSignal);
  });
  const settled = await collectPanel(calls, { ...cfg, minPanel }, (results) => {
    panelControllers.forEach((controller, i) => {
      if (!results[i]?.ok) controller.abort();
    });
  }, signal);
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);
  if (signal?.aborted) return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), { status: 499, headers: { "Content-Type": "application/json" } });

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const text = res.panelText;
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const finalModel = answers.length === 1 ? answers[0].model : judge;
  const judgeBody = answers.length === 1 ? body : appendUserTurn(body, buildJudgePrompt(answers));
  const judgeRefs = modelRefs.has(finalModel) ? modelRefs : await resolveCandidateRefs([finalModel], resolveModelInfo, log);
  if (getContextFit(judgeBody, judgeRefs.get(finalModel)).reason === "output_limit_exceeded") return contextCapacityResponse();
  if (signal?.aborted) return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), { status: 499, headers: { "Content-Type": "application/json" } });
  if (answers.length > 1) log.info("FUSION", `Judging ${answers.length} answers with ${finalModel}`);
  const judgeController = new AbortController();
  const judgeSignal = signal ? AbortSignal.any([signal, judgeController.signal]) : judgeController.signal;
  const judged = await withTimeout(handleSingleModel(judgeBody, finalModel, undefined, { signal: judgeSignal }),
    cfg.panelHardTimeoutMs, () => judgeController.abort(), judgeSignal);
  if (judged.__aborted) return new Response(JSON.stringify({ error: { message: "Request aborted by client" } }), { status: 499, headers: { "Content-Type": "application/json" } });
  if (judged.__timeout || judged.__error) {
    judgeController.abort();
    return new Response(JSON.stringify({ error: { message: judged.__timeout ? "Fusion judge response deadline exceeded" : "Fusion judge failed" } }), { status: judged.__timeout ? 504 : 502, headers: { "Content-Type": "application/json" } });
  }
  return judged;
}

/**
 * Rebuild a ReadableStream from a reader that already had `head` bytes pulled
 * (by comboStreamGuard) plus the rest of the stream.
 */
/**
 * Deduplicate identical SSE `data:` lines within a single stream.
 *
 * Some OpenRouter free-tier models (notably `minimax/minimax-m3:free`)
 * emit the same assistant payload in two consecutive chunks, which the
 * Claude Code client then renders twice (AskUserQuestion in duplicate,
 * tool-call flashes doubled). The gateway is downstream of the upstream
 * and cannot stop the duplication, so we collapse byte-identical lines
 * before forwarding. Order of first occurrence is preserved; the second
 * copy of any repeated line is dropped.
 *
 * Heuristic: hash the raw `data:` payload (excluding the SSE framing
 * whitespace) and skip a chunk when its hash has already been emitted.
 * The hash is 16 hex chars (FNV-1a 64-bit) — collision probability
 * per stream is negligible for ~hundreds of chunks.
 *
 * Implemented as a stateful function (not TransformStream) so it
 * works uniformly under Node's ReadableStream (vitest's test
 * environment does not support `.pipeThrough()` on user-constructed
 * streams).
 */
function createDedupState() {
  return { lastHash: "" };
}

/**
 * @param {Uint8Array|string} chunk
 * @param {{ lastHash: string }} state
 * @returns {Uint8Array|null} the chunk with duplicate lines stripped,
 *   or null if nothing should be forwarded.
 */
function dedupChunk(chunk, state) {
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  const lines = text.split(/(\n\n)/);
  // Pre-collect content vs. separator tokens so we can decide which parts
  // to keep deterministically: a kept line is appended; a duplicate line
  // is dropped, along with the `\n\n` separator that would have followed
  // it (otherwise we'd emit a stray blank event).
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part === "\n\n") continue;
    const trimmed = part.startsWith("data:") ? part.slice(5).trim() : part.trim();
    if (!trimmed || trimmed === "[DONE]") {
      out.push(part);
      continue;
    }
    // Tiny FNV-1a 64-bit — same hash function as providerModelsFetcher.js
    let h = 0xcbf29ce484222325n;
    for (let j = 0; j < trimmed.length; j++) {
      h = (h ^ BigInt(trimmed.charCodeAt(j))) * 0x100000001b3n & 0xffffffffffffffffn;
    }
    const hex = h.toString(16);
    if (hex === state.lastHash) continue; // back-to-back dup of the previous line only
    state.lastHash = hex;
    out.push(part);
  }
  if (out.length === 0) return null;
  const joined = out.join("\n\n");
  return typeof chunk === "string" ? joined : new TextEncoder().encode(joined);
}

export function pipeStreamWithHead(reader, head, onDone, onCancel) {
  let doneCalled = false;
  const callDone = () => {
    if (!doneCalled) {
      doneCalled = true;
      if (typeof onDone === "function") onDone();
    }
  };
  const dedupState = createDedupState();
  return new ReadableStream({
    async start(controller) {
      if (head && head.length > 0) {
        const filteredHead = dedupChunk(head, dedupState);
        if (filteredHead && filteredHead.length > 0) {
          controller.enqueue(filteredHead);
        }
      }
    },
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            try { controller.close(); } catch {}
            callDone();
            return;
          }
          const filtered = dedupChunk(value, dedupState);
          if (filtered && filtered.length > 0) {
            controller.enqueue(filtered);
            return;
          }
        }
      } catch (err) {
        console.error("[combo] pipeStreamWithHead failed:", err?.message || err);
        try { controller.error(err); } catch {}
        callDone();
      }
    },
    async cancel(reason) {
      try {
        if (typeof onCancel === "function") onCancel(reason);
      } finally {
        callDone();
        await safeCancelStream(reader);
      }
    },
  });
}
// DEBUG
globalThis.__dedupCalls = (globalThis.__dedupCalls || 0);
