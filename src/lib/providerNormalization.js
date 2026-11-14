import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function parseOllamaResetDay(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  if (provider === "ollama") {
    const rawResetDay = next.resetDay !== undefined ? next.resetDay : body.resetDay;
    const parsedResetDay = parseOllamaResetDay(rawResetDay);
    if (parsedResetDay !== null) {
      next.resetDay = parsedResetDay;
    } else {
      delete next.resetDay;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}
