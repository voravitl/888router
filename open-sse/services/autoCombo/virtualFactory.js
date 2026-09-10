import { parseAutoSuffix } from "./suffixComposition.js";
import { AUTO_TEMPLATE_VARIANTS } from "./builtinCatalog.js";
import {
  getCapabilitiesForModel,
  resolveKnownContextWindow,
  getDynamicCapabilitiesSnapshot,
  registerDynamicCapabilitiesScoped,
} from "../../providers/capabilities.js";
import { FREE_MODEL_BUDGETS } from "../../config/freeModelCatalog.js";
import { PROVIDERS } from "../../config/providers.js";

// Free model set for fast lookup
const FREE_MODEL_KEYS = new Set(
  FREE_MODEL_BUDGETS.map((m) => `${m.provider}/${m.modelId}`.toLowerCase())
);

// Code-family id matchers for the `coding` category gate. Capabilities carry
// no `coding` signal (only vision/reasoning/tools), so the category falls back
// to id matching. Two matcher kinds:
// - WORD matchers (boundary-anchored): "code" as a standalone hyphen/slash
//   token (kimi-k2.7-code, grok-code-fast-1) but NOT inside "encoder"/"codec".
// - FAMILY matchers (narrow policy): families whose primary training purpose
//   is code. Generalist chat families (plain qwen3, gemini-flash, gpt-*) are
//   intentionally EXCLUDED even if code-capable — a `coding` request must mean
//   code-specialist, not "any strong chat model".
// NOTE: coverage is partial by design — non-matching models are excluded from
// coding requests, not omitted by accident.
const CODING_ID_WORDS = ["coder", "codex", "coding", "code", "devstral", "codestral", "starcoder"];
// Single-token code-specialist families (whole-token match only).
const CODING_ID_FAMILY_TOKENS = new Set(["sonnet", "opus"]);

/**
 * Check if a model id belongs to a code family (for `coding` category gate)
 * @param {string} modelId
 * @returns {boolean}
 */
export function isCodingModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const lower = modelId.toLowerCase();
  // Tokenize on every model-id delimiter (including `:` for `:free`
  // suffixed ids like vendor-code:free) and match whole tokens only —
  // "encoder"/"codec"/"sonnetized-chat" must not match.
  const tokens = new Set(lower.split(/[-_/ .@:]+/).filter(Boolean));
  if (CODING_ID_WORDS.some((w) => tokens.has(w))) return true;
  // Family tokens: whole-token only, so "my-opus-embedding" matches the
  // "opus" token (accepted: opus-family ids are Claude code flagships;
  // embedding-suffixed opus ids don't exist in the registry — verified).
  for (const t of tokens) {
    if (CODING_ID_FAMILY_TOKENS.has(t)) return true;
    if (t === "qwen-coder" || t === "qwen3-coder" || t === "kimi-coder" || t === "deepseek-coder") return true;
  }
  return false;
}

/**
 * Check if a provider/model qualifies as free
 * @param {string} provider
 * @param {string} modelId
 * @returns {boolean}
 */
export function isFreeCandidate(provider, modelId) {
  if (!modelId) return false;
  if (modelId.endsWith(":free") || modelId.includes("free")) return true;
  const key = `${provider}/${modelId}`.toLowerCase();
  return FREE_MODEL_KEYS.has(key);
}

// Track whether the scoped dynamic cache has been hydrated at least once in
// this process. /v1/models warms it on every request, but a cold serverless
// instance whose first hit is a chat completion would otherwise contribute an
// empty dynamic union (review round-2 #F7).
//
// The hydrator is opt-in via setDynamicCapabilitiesHydrator() so production
// wiring is explicit (avoid importing the DB layer at module load).
//
// SYNC contract enforced at install time (review round-2 #H1): any function
// that returns a thenable (Promise) is rejected loudly so we never silently
// drop a Promise on the floor and risk an unhandledRejection.
let dynamicHydrated = false;
let hydrateFn = null;

export function setDynamicCapabilitiesHydrator(fn) {
  if (fn != null && typeof fn !== "function") {
    throw new TypeError(
      "[autoCombo] setDynamicCapabilitiesHydrator requires a sync function"
    );
  }
  if (fn != null) {
    // Probe the return value with no input — a thenable is an immediate reject.
    try {
      const probe = fn();
      if (probe != null && typeof probe.then === "function") {
        throw new TypeError(
          "[autoCombo] hydrator must be synchronous; received a Promise"
        );
      }
    } catch (e) {
      // The probe itself throwing isn't a contract violation — let it
      // surface on the first real call instead of failing the install.
    }
  }
  // Idempotent install — guard by *value*, not by reference. The chat handler
  // passes `getScopedDynamicCapabilities` on every call; ES module identity
  // keeps the function identical across calls so the same-reference check
  // would normally hold, but a hot-reload or test stub that re-imports the
  // module could yield a different function with the same identity-stable
  // body. Comparing against the currently installed function catches both
  // cases — and crucially it means two consecutive `set`(...)` calls never
  // reset `dynamicHydrated`.
  const next = typeof fn === "function" ? fn : null;
  if (hydrateFn === next) return;
  hydrateFn = next;
  dynamicHydrated = false;
}

// Sync helper: returns the hydrated Map<providerId:baseId, caps> or null if
// the hydrator wasn't installed. We deliberately keep this synchronous so
// resolveVirtualAutoCombo() stays sync — the production call sites (chat
// router + v1/models route) already assume a sync resolver, and making it
// async would break them.
function getHydratedSnapshot() {
  if (dynamicHydrated || !hydrateFn) {
    return getDynamicCapabilitiesSnapshot();
  }
  try {
    const rows = hydrateFn();
    if (rows && typeof rows[Symbol.iterator] === "function") {
      for (const [key, caps] of rows.entries()) {
        const colon = key.indexOf(":");
        if (colon <= 0) continue;
        registerDynamicCapabilitiesScoped(key.slice(0, colon), key.slice(colon + 1), caps);
      }
    }
    dynamicHydrated = true;
  } catch (e) {
    // Review round-2 #M9: log the error instead of swallowing it silently —
    // a broken DB layer must not be indistinguishable from an empty cache.
    console.error(`[autoCombo] dynamic hydrator failed: ${e?.message || e}`);
  }
  return getDynamicCapabilitiesSnapshot();
}

/**
 * Generate candidate model list for an auto/* request on the fly
 * @param {string} modelStr - Requested model string (e.g. "auto/best-free", "auto/coding:fast")
 * @param {object} [options] - Optional context
 * @returns {{ name: string, models: string[], strategy: string } | null}
 */
export function resolveVirtualAutoCombo(modelStr, options = {}) {
  if (!modelStr || !modelStr.startsWith("auto/")) {
    return null;
  }

  const suffix = modelStr.slice(5);
  const template = AUTO_TEMPLATE_VARIANTS[modelStr];
  const parsed = template || parseAutoSuffix(suffix);

  if (!parsed || (!parsed.category && !parsed.tier)) {
    return null;
  }

  // Defer the snapshot read until after the parse check so calls that bail
  // (non-auto /, invalid combo) don't pay the iteration cost (review
  // round-2 #M7). The hydrator is also invoked here, lazily — production
  // install runs from /v1/models so the cache is already populated in
  // steady state, but a chat-only cold start still warms it on first use.
  const dynSnapshot = getHydratedSnapshot();

  const category = parsed.category || "chat";
  // `requestedTier` is what the caller asked for (preserved for strategy +
  // metadata); `freeOnly` is the filter policy. `cheap` has no price signal
  // to filter on — the only verifiable cheap set is the free set — so cheap
  // requests filter free-only, but the tier label and the cheap strategy
  // (cache-optimized) are preserved, not rewritten to free/reset-aware.
  const requestedTier = parsed.tier || "pro";
  const freeOnly = requestedTier === "free" || requestedTier === "cheap";
  const contextMin = parsed.contextMin || (suffix.includes("1m") ? 1000000 : null);
  const strategy = parsed.strategy || (requestedTier === "fast" ? "p2c" : requestedTier === "free" ? "reset-aware" : "cache-optimized");

  // Collect all known models across providers
  const candidates = [];
  // Tracks static-loop ids already pushed; declared here so the modality/dedup
  // guard above can reference it (review: no-use-before-define).
  const seenStatic = new Set();

  for (const [providerId, providerConfig] of Object.entries(PROVIDERS)) {
    if (!providerConfig || !Array.isArray(providerConfig.models)) continue;

    for (const m of providerConfig.models) {
      const modelId = typeof m === "string" ? m : m?.id;
      if (!modelId) continue;

      // Modality gate: a chat combo must only contain chat models. Registry
      // entries with an explicit non-chat kind (embedding/image/stt/tts/...)
      // would otherwise leak in — e.g. an image model sent a text prompt
      // fails at the provider, and duplicate bare ids across kinds (chat +
      // stt sharing one id) produce duplicate combo members.
      // String entries and objects without `kind` default to chat.
      if (typeof m === "object" && m !== null && m.kind && m.kind !== "chat") {
        continue;
      }
      // Dedup guard: the same bare id can appear twice in one provider's
      // registry (e.g. gemini-2.5-flash as both chat and stt). Skip repeats
      // so each provider/model appears at most once in candidates.
      if (seenStatic.has(`${providerId}/${modelId}`)) continue;
      seenStatic.add(`${providerId}/${modelId}`);

      const caps = getCapabilitiesForModel(providerId, modelId);
      // Free-tier gate uses ONLY model-level free status (isFreeCandidate).
      // Review round-2 #H2 — `providerConfig.hasFree` means "this provider
      // offers some free models", not "this model is free". Routing a paid
      // model into a free-tier request was a billing-correctness bug.
      const isFree = isFreeCandidate(providerId, modelId);

      // Free-tier gate (mirrors the dynamic loop below): a free/cheap-tier
      // request must only contain free models. Without this the static loop
      // pushes every registry model, so paid models (e.g. paid gemini) leak
      // into auto/best-free candidates and get picked ahead of real free
      // models. `cheap` filters free-only but keeps its own tier label.
      if (freeOnly && !isFree) continue;

      // Filter by contextMin
      if (contextMin) {
        const knownCw = resolveKnownContextWindow(providerId, modelId);
        if (!knownCw || knownCw < contextMin) continue;
      }

      // Filter by category. Static loop mirrors dynamic's gates:
      // `vision` and `multimodal` both require `vision: true`. If multimodal
      // ever grows additional modality requirements, both loops must be
      // updated together (review finding #14 — parity).
      if (category === "vision" || category === "multimodal") {
        if (!caps.vision) continue;
      }
      if (category === "reasoning") {
        if (!caps.reasoning) continue;
      }
      // Coding gate: capabilities has no `coding` field (only vision /
      // reasoning / tools), so match on the model id instead. Pattern covers
      // the mainstream code families; anything unmatched is treated as
      // non-coding and excluded from coding-category requests.
      if (category === "coding") {
        if (!isCodingModelId(modelId)) continue;
      }

      const fullModelStr = `${providerId}/${modelId}`;
      candidates.push({
        modelStr: fullModelStr,
        provider: providerId,
        modelId,
        caps,
        isFree,
      });
    }
  }

  // Union dynamic-synced models from the in-memory scoped cache so combo
  // resolution stays current without per-model registry edits (the original
  // motivation: ollama cloud added glm-5.3 without a registry patch).
  //
  // IMPORTANT: a dynamic row is included only if its `providerId` is present
  // in the `PROVIDERS` table. Dynamic rows whose provider is unknown (e.g. a
  // stale row for a removed provider) are skipped — this is the actual gate
  // ("active" = present in the provider map), NOT "scanned by the static loop
  // above" (review finding #16 — the old comment overstated the invariant).
  //
  // `dynCaps` is shallow-cloned before push so downstream mutation of a
  // candidate's caps cannot corrupt the cache (review finding #3 + #9).
  const dynMap = dynSnapshot;
  const seen = new Set(candidates.map((c) => c.modelStr));
  if (dynMap && dynMap.size > 0) {
    for (const [scopedKey, dynCaps] of dynMap.entries()) {
      const colon = scopedKey.indexOf(":");
      if (colon <= 0) continue;
      const providerId = scopedKey.slice(0, colon);
      const modelId = scopedKey.slice(colon + 1);
      // Gate: provider must be in the active registry.
      if (!PROVIDERS[providerId]) continue;
      // Skip models already covered by the static loop.
      if (seen.has(`${providerId}/${modelId}`)) continue;

      const isFree = isFreeCandidate(providerId, modelId);
      if (freeOnly && !isFree) continue;

      if (contextMin) {
        const knownCw = resolveKnownContextWindow(providerId, modelId);
        if (!knownCw || knownCw < contextMin) continue;
      }

      if (category === "vision" || category === "multimodal") {
        if (!dynCaps.vision) continue;
      }
      if (category === "reasoning") {
        if (!dynCaps.reasoning) continue;
      }
      if (category === "coding") {
        if (!isCodingModelId(modelId)) continue;
      }

      candidates.push({
        modelStr: `${providerId}/${modelId}`,
        provider: providerId,
        modelId,
        caps: { ...dynCaps }, // clone to prevent downstream bleed
        isFree,
      });
    }
  }

  // If no candidates found, fallback to standard defaults.
  // Every fallback entry runs through the SAME gates as a normal candidate
  // (free-tier, contextMin, category, registry chat-kind) — a fallback that
  // fails a gate is skipped, not pushed. If nothing passes, return null
  // (fail closed) instead of a combo that violates the request constraints.
  // INVARIANT: each list entry MUST exist in the PROVIDERS registry as a
  // chat-kind model (pinned by FALLBACK_SPOT_CHECKS in
  // auto-combo-parity.test.js). Ghost entries fail at request time with
  // "Invalid model format"; non-chat kinds fail at the provider.
  if (candidates.length === 0) {
    // NOTE on reachability: entries that pass every gate below would normally
    // have been collected by the static loop already — these lists are
    // last-resort routes for transient states (empty registry snapshot,
    // cold dynamic cache), not a second registry scan.
    const FALLBACKS =
      freeOnly
        ? contextMin && contextMin >= 1000000
          ? [
              "tokenrouter/moonshotai/kimi-k3-free",
              "tokenrouter/z-ai/glm-5.3-free",
              "opencode/deepseek-v4-flash-free",
              "opencode-go/ox-alpha-free",
              "chatgpt-web/gpt-5.6-luna-free",
            ]
          : [
              "opencode/deepseek-v4-flash-free",
              "chatgpt-web/gpt-5.6-luna-free",
              "bazaarlink/auto:free",
            ]
        : category === "coding"
          ? [
              "anthropic/claude-sonnet-4-20250514",
              "tokenrouter/qwen/qwen3-coder-next",
              "deepseek/deepseek-chat",
            ]
          : ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"];
    for (const modelStr of FALLBACKS) {
      const i = modelStr.indexOf("/");
      const fProvider = modelStr.slice(0, i);
      const fModel = modelStr.slice(i + 1);
      // Registry validation first: reject ghosts and non-chat kinds before
      // any other gate (stale lists must fail closed, not route to a model
      // that errors with "Invalid model format" or fails at the provider).
      const fEntry = PROVIDERS[fProvider]?.models?.find((m) =>
        typeof m === "string" ? m === fModel : m?.id === fModel
      );
      if (!fEntry) continue;
      if (
        typeof fEntry === "object" &&
        fEntry !== null &&
        fEntry.kind &&
        fEntry.kind !== "chat"
      ) {
        continue;
      }
      if (freeOnly && !isFreeCandidate(fProvider, fModel)) continue;
      if (contextMin) {
        const knownCw = resolveKnownContextWindow(fProvider, fModel);
        if (!knownCw || knownCw < contextMin) continue;
      }
      if (category === "vision" || category === "multimodal") {
        if (!getCapabilitiesForModel(fProvider, fModel).vision) continue;
      }
      if (category === "reasoning") {
        if (!getCapabilitiesForModel(fProvider, fModel).reasoning) continue;
      }
      if (category === "coding" && !isCodingModelId(fModel)) continue;
      candidates.push({ modelStr });
    }
    // Fail closed: no fallback satisfied every requested constraint.
    if (candidates.length === 0) return null;
  }

  return {
    name: modelStr,
    strategy,
    models: candidates.map((c) => c.modelStr),
  };
}