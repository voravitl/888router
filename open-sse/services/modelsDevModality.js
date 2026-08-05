/**
 * models.dev modality enrichment — authoritative source for model capabilities.
 *
 * opencode's /zen/v1/models endpoint returns only { id, object, created,
 * owned_by } — NO modality/vision/reasoning. So the gateway cannot know from
 * the live sync whether a model can read images. If it assumes vision and
 * forwards an image_url block to a text-only model, upstream rejects it with
 * 400 "unknown variant image_url, expected text".
 *
 * This module fetches models.dev/api.json (the same authoritative source the
 * static capabilities table documents) and enriches a model list with
 * vision/reasoning/contextWindow from the matching entry. Cached in-memory so
 * the dashboard sync doesn't hit models.dev on every request.
 *
 * This is the MECHANISM fix: new models opencode adds get correct modality
 * automatically, instead of hand-editing the static pattern table per model.
 */

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — catalog changes rarely
const FETCH_TIMEOUT_MS = 10_000;

/** @type {{ ts: number, byId: Map<string, {vision:boolean, reasoning:boolean, contextWindow?:number}> } | null} */
let cache = null;

/**
 * Fetch + index models.dev once (cached). Returns a Map keyed by model id
 * (both bare and provider-prefixed) → { vision, reasoning, contextWindow }.
 * Returns null on any failure (callers fail-open to the static table).
 */
async function loadModelsDevIndex() {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.byId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("models.dev timeout")), FETCH_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) {
      if (cache) cache.ts = now; // soft backoff
      return cache?.byId || null;
    }
    data = await res.json();
  } catch {
    if (cache) cache.ts = now; // soft backoff
    return cache?.byId || null;
  } finally {
    clearTimeout(timer);
  }

  const byId = new Map();
  for (const [provider, pv] of Object.entries(data || {})) {
    if (!pv || typeof pv !== "object") continue;
    for (const [mid, info] of Object.entries(pv.models || {})) {
      if (!info || typeof info !== "object") continue;
      const input = info.modalities?.input;
      const entry = {
        vision: Array.isArray(input) && input.includes("image"),
        reasoning: info.reasoning === true,
        contextWindow: info.limit?.context,
      };
      // index by bare id (deepseek-v4-flash-free), prefixed (opencode/deepseek-v4-flash-free),
      // and provider-scoped (opencode:deepseek-v4-flash-free) so lookups can prefer
      // the provider-scoped entry and avoid bare-id collisions across providers.
      byId.set(mid, entry);
      const slash = mid.indexOf("/");
      if (slash > 0) byId.set(mid.slice(slash + 1), entry);
      byId.set(`${provider}:${mid}`, entry);
      if (slash > 0) byId.set(`${provider}:${mid.slice(slash + 1)}`, entry);
    }
  }

  cache = { ts: now, byId };
  return byId;
}

/**
 * Enrich an array of model objects ({ id, ... }) with vision/reasoning from
 * models.dev. Mutates and returns the same array. Models not found in
 * models.dev are left untouched (static table / pattern still applies).
 *
 * @param {Array<{id:string}>} models
 * @param {string} [provider] provider key in models.dev (e.g. "opencode")
 * @returns {Promise<Array>} the same array, enriched
 */
export async function enrichModalityFromModelsDev(models, provider = "") {
  if (!Array.isArray(models) || models.length === 0) return models;
  const index = await loadModelsDevIndex();
  if (!index) return models; // fail-open

  for (const m of models) {
    if (!m || typeof m.id !== "string") continue;
    // Prefer provider-scoped lookup (opencode:deepseek-v4-flash-free) to avoid
    // bare-id collisions across providers; fall back to bare id.
    const entry = provider
      ? (index.get(`${provider}:${m.id}`) || index.get(m.id))
      : index.get(m.id);
    if (!entry) continue;
    // Only set when the live sync didn't already provide it (upstream wins).
    if (m.vision === undefined) m.vision = entry.vision;
    if (m.reasoning === undefined) m.reasoning = entry.reasoning;
    if (m.context_length === undefined && entry.contextWindow) m.context_length = entry.contextWindow;
  }
  return models;
}

/** Clear the in-memory cache (tests / manual refresh). */
export function clearModelsDevCache() {
  cache = null;
}
