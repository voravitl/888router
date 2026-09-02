import { parseAutoSuffix } from "./suffixComposition.js";
import { AUTO_TEMPLATE_VARIANTS } from "./builtinCatalog.js";
import { getCapabilitiesForModel, resolveKnownContextWindow, getDynamicCapabilitiesSnapshot } from "../../providers/capabilities.js";
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
      const isFree = isFreeCandidate(providerId, modelId) || providerConfig.hasFree === true;

      // Filter by tier
      if (tier === "free" && !isFree) continue;

      // Filter by contextMin
      if (contextMin) {
        const knownCw = resolveKnownContextWindow(providerId, modelId);
        if (!knownCw || knownCw < contextMin) continue;
      }

      // Filter by category
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
  // motivation: ollama cloud added glm-5.3 without a registry patch). Capped
  // to providerIds already scanned above — non-active providers stay excluded.
  // Scoped cache key is `${providerId}:${baseId}` (review finding #5).
  const dynMap = (typeof getDynamicCapabilitiesSnapshot === "function")
    ? getDynamicCapabilitiesSnapshot()
    : null;
  const seen = new Set(candidates.map((c) => c.modelStr));
  if (dynMap && dynMap.size > 0) {
    for (const [scopedKey, dynCaps] of dynMap.entries()) {
      const colon = scopedKey.indexOf(":");
      if (colon <= 0) continue;
      const providerId = scopedKey.slice(0, colon);
      const modelId = scopedKey.slice(colon + 1);
      // Skip providers we didn't enter above (non-active providers excluded).
      if (!PROVIDERS[providerId]) continue;
      // Skip models already covered by the static loop.
      if (seen.has(`${providerId}/${modelId}`)) continue;

      const isFree = isFreeCandidate(providerId, modelId) || PROVIDERS[providerId].hasFree === true;
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
        caps: dynCaps,
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
    models: candidates.map((c) => c.modelStr),
    strategy,
  };
}
