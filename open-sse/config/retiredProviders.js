/**
 * Provider IDs (and historical aliases) that were removed from the registry.
 * Kept so leftover dashboard connections / combo entries fail closed instead of
 * falling through DefaultExecutor → OpenAI (PROVIDERS[id] || PROVIDERS.openai).
 */
export const RETIRED_PROVIDER_IDS = Object.freeze([
  "duckduckgo-web",
  "ddg-web",
  "ddgw",
  "duckchat",
  "ddg",
]);

const RETIRED = new Set(RETIRED_PROVIDER_IDS);

export function isRetiredProvider(id) {
  return typeof id === "string" && RETIRED.has(id.toLowerCase());
}

export function retiredProviderMessage(id) {
  return `Provider '${id}' has been removed`;
}
