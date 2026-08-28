// Fetch and cache suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Cache key includes a short hash of the apiKey so different connections on
// the same provider URL do not leak cached models between users (9-opus review).
const cache = new Map();

function shortHash(input) {
  // FNV-1a 32-bit, base36 — short, no crypto import needed, collision-safe in
  // the cache map because we never have more than a few hundred entries.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Fetch suggested models for a provider using its modelsFetcher config.
 * Results are cached in-memory for CACHE_TTL_MS.
 * @param {{ url: string, type: string }} fetcher
 * @param {{ apiKey?: string }} [opts] - Optional API key for private providers (b.ai, gmi, etc.)
 * @returns {Promise<Array<{ id: string, name: string, contextLength?: number }>>}
 */
export async function fetchSuggestedModels(fetcher, opts = {}) {
  if (!fetcher?.url || !fetcher?.type) return [];

  const apiKey = typeof opts.apiKey === "string" && opts.apiKey ? opts.apiKey : null;
  const cacheKey = apiKey
    ? `${fetcher.url}|k:${shortHash(apiKey)}`
    : `${fetcher.url}|anon`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const params = new URLSearchParams({ url: fetcher.url, type: fetcher.type });
    // Send the API key in a custom header so it never lands in URLs / logs /
    // browser history. Same-origin so the browser still attaches cookies.
    const headers = apiKey ? { "X-Provider-Key": apiKey } : undefined;
    const res = await fetch(`/api/providers/suggested-models?${params}`, { headers });
    if (!res.ok) return [];
    const json = await res.json();
    const data = json.data ?? [];
    cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch {
    return [];
  }
}
