/**
 * OpenCode Go live catalog fetcher.
 *
 * GET https://opencode.ai/zen/go/v1/models with `Authorization: Bearer
 * public` returns the current paid-catalog ids (OpenAI `{object,list,data}`
 * shape). The catalog is PUBLIC — never forward a user's private API key.
 *
 * Results feed /v1/models + dashboard via LIVE_MODEL_RESOLVERS["opencode-go"]
 * so newly-released upstream models appear without registry edits. Live ids
 * carry no supportedFormats — they route openai-only by the chatCore guard;
 * the static registry seed stays the transport-capability source of truth.
 *
 * Fail-open everywhere: timeout / non-2xx / malformed body → null, and the
 * static seed serves. In-memory cache (10 min TTL) + in-flight dedup so
 * concurrent /v1/models requests fan out exactly one upstream call.
 */

const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
// Negative cache: a failed fetch (timeout/non-2xx/malformed) suppresses
// retries briefly so sequential /v1/models requests during an outage don't
// each stall 8s and hammer upstream. Static seed serves meanwhile.
const NEG_CACHE_TTL_MS = 30 * 1000;
const MAX_MODELS = 500;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 512;

let cached = null; // { expiresAt, models } | null
let negCachedUntil = 0;
let inflight = null;

/**
 * Normalize one raw catalog entry. Returns null for malformed entries.
 */
export function normalizeOpenCodeGoModel(m) {
  if (!m || typeof m !== "object") return null;
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id || id.length > MAX_ID_LENGTH) return null;
  // Reject control characters — they corrupt UI rows / downstream schemas.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(id)) return null;
  const rawName = typeof m.name === "string" ? m.name.trim() : "";
  const name = (rawName || id).slice(0, MAX_NAME_LENGTH);
  return { id, name };
}

/**
 * Parse a live catalog body into deduped {id,name} models. Pure — testable
 * without network. Static seed wins on collision downstream (not here).
 */
export function parseOpenCodeGoCatalog(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const seen = new Set();
  const models = [];
  for (const m of data.slice(0, MAX_MODELS)) {
    const norm = normalizeOpenCodeGoModel(m);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    models.push(norm);
  }
  return models;
}

/** Clear cache (tests + credential rotation). */
export function resetOpenCodeGoCatalogForTests() {
  cached = null;
  negCachedUntil = 0;
  inflight = null;
}

/**
 * Fetch the live catalog. Returns { models } or null on any failure.
 * @param {object} [opts] - { fetchImpl } for tests.
 */
export async function resolveOpenCodeGoModels({ fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached;
  if (now < negCachedUntil) return null;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let json;
      try {
        const res = await fetchImpl(CATALOG_URL, {
          headers: { Authorization: "Bearer public" },
          signal: controller.signal,
        });
        if (!res.ok) {
          negCachedUntil = Date.now() + NEG_CACHE_TTL_MS;
          return null;
        }
        json = await res.json();
      } finally {
        clearTimeout(timeout);
      }
      const models = parseOpenCodeGoCatalog(json);
      if (models.length === 0) {
        negCachedUntil = Date.now() + NEG_CACHE_TTL_MS;
        return null;
      }
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, models };
      return cached;
    } catch {
      negCachedUntil = Date.now() + NEG_CACHE_TTL_MS;
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
