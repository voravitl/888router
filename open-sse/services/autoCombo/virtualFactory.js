import { parseAutoSuffix } from "./suffixComposition.js";
import { AUTO_TEMPLATE_VARIANTS } from "./builtinCatalog.js";
import {
  getCapabilitiesForModel,
  resolveKnownContextWindow,
  getDynamicCapabilitiesSnapshot,
} from "../../providers/capabilities.js";
import { FREE_MODEL_BUDGETS } from "../../config/freeModelCatalog.js";
import { PROVIDERS } from "../../config/providers.js";

// Free model set for fast lookup
const FREE_MODEL_KEYS = new Set(
  FREE_MODEL_BUDGETS.map((m) => `${m.provider}/${m.modelId}`.toLowerCase())
);

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
          "[autoCombo] hydrator must be synchronous; rejected a thenable"
        );
      }
    } catch (e) {
      if (e instanceof TypeError) throw e;
    }
  }
  hydrateFn = typeof fn === "function" ? fn : null;
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
      const writer = require("../../providers/capabilities.js").registerDynamicCapabilitiesScoped;
      for (const [key, caps] of rows.entries()) {
        const colon = key.indexOf(":");
        if (colon <= 0) continue;
        writer(key.slice(0, colon), key.slice(colon + 1), caps);
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
  const tier = parsed.tier || "pro";
  const contextMin = parsed.contextMin || (suffix.includes("1m") ? 1000000 : null);
  const strategy = parsed.strategy || (tier === "fast" ? "p2c" : tier === "free" ? "reset-aware" : "cache-optimized");

  // Collect all known models across providers
  const candidates = [];

  for (const [providerId, providerConfig] of Object.entries(PROVIDERS)) {
    if (!providerConfig || !Array.isArray(providerConfig.models)) continue;

    for (const m of providerConfig.models) {
      const modelId = typeof m === "string" ? m : m?.id;
      if (!modelId) continue;

      const caps = getCapabilitiesForModel(providerId, modelId);
      // Free-tier gate uses ONLY model-level free status (isFreeCandidate).
      // Review round-2 #H2 — `providerConfig.hasFree` means "this provider
      // offers some free models", not "this model is free". Routing a paid
      // model into a free-tier request was a billing-correctness bug.
      const isFree = isFreeCandidate(providerId, modelId);

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
      if (tier === "free" && !isFree) continue;

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

      candidates.push({
        modelStr: `${providerId}/${modelId}`,
        provider: providerId,
        modelId,
        caps: { ...dynCaps }, // clone to prevent downstream bleed
        isFree,
      });
    }
  }

  // If no candidates found, fallback to standard defaults
  if (candidates.length === 0) {
    if (tier === "free") {
      if (contextMin && contextMin >= 1000000) {
        candidates.push(
          { modelStr: "openrouter/minimax/minimax-m3:free" },
          { modelStr: "kgw/minimax/minimax-m3:free" },
          { modelStr: "tokenrouter/deepseek/deepseek-v4-pro-0813-free" },
          { modelStr: "tokenrouter/moonshotai/kimi-k3-free" },
          { modelStr: "tokenrouter/qwen/qwen3.8-max-free" }
        );
      } else {
        candidates.push(
          { modelStr: "openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free" },
          { modelStr: "agentrouter/claude-opus-4-8" },
          { modelStr: "bazaarlink/auto:free" }
        );
      }
    } else if (category === "coding") {
      candidates.push(
        { modelStr: "anthropic/claude-3-7-sonnet" },
        { modelStr: "deepseek/deepseek-chat" },
        { modelStr: "openai/gpt-4o" }
      );
    } else {
      candidates.push(
        { modelStr: "openai/gpt-4o" },
        { modelStr: "anthropic/claude-3-7-sonnet" }
      );
    }
  }

  return {
    name: modelStr,
    strategy,
    models: candidates.map((c) => c.modelStr),
  };
}