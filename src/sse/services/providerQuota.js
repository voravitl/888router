/**
 * Live quota cache + strike circuit breaker — in-memory, refreshed on demand.
 * Used by the auth.js pre-filter to skip accounts whose model quota is
 * exhausted, and by the chat handler on 409/429 to sync the exact resetAt
 * from upstream before any lock is persisted.
 *
 * Two signal classes, chosen by provider:
 *   antigravity   quota API exists (getAntigravityUsage) → refresh the cache
 *                 and trust its resetAt; a reading that contradicts a 429 is
 *                 counted as a strike instead.
 *   ollama /      no quota API → strikes only. Three 429/409s on the same
 *   opencode-free connection+model inside the window block the pair for
 *   STRIKE_BLOCK_MS, because the free tier's real window (hourly+) is much
 *   longer than the seconds/minutes backoff the generic path parks.
 *
 * Modeled on upstream decolua/9router src/sse/services/antigravityQuota.js,
 * generalized so a provider registers rather than being special-cased here.
 * In-memory only: no DB row is written for cache entries, so a restart clears
 * it and a persisted modelLock_* (which IS capped) never carries a long window.
 */

import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { getAntigravityUsage } from "open-sse/services/usage/google.js";
import * as log from "../utils/logger.js";

// Providers with a live quota API to consult. Anything else still gets the
// strike breaker (no upstream truth available), but never an optimistic one.
const QUOTA_API_PROVIDERS = new Set(["antigravity"]);

// In-memory cache: connectionId → { [modelId]: { remainingPercentage, resetAt } }
const quotaCache = new Map();
// Track last refresh per connection to avoid hammering
const lastRefreshAt = new Map();
// In-flight refresh promises — dedup concurrent 409/429 bursts
const inflightRefresh = new Map();

const MIN_REFRESH_INTERVAL_MS = 30_000; // 30s between refreshes per connection

// Strike-based circuit breaker: Google's quota API can report remaining quota
// while generation endpoints keep returning 429 (sprint/weekly dual-pool
// mismatch), and ollama/opencode-free have no reset timestamp at all — a bare
// "Rate limit exceeded" parks the account for seconds/minutes and it comes
// straight back. After STRIKE_THRESHOLD 429s within the window for the same
// connection+model, treat optimistic-or-absent readings as untrusted and
// cache-block that pair instead of retry-storming upstream.
const STRIKE_WINDOW_MS = 60_000; // strikes older than this reset the count
const STRIKE_THRESHOLD = 3;
const STRIKE_BLOCK_MS = 15 * 60_000;
// Strike-only providers park for a SHORTER window: their limit is a rolling
// per-account wall (ollama cloud RPM, opencode free tier), not a scheduled
// reset — a 15m block would idle a working model ~15x past its real
// recovery. (review F3)
const STRIKE_ONLY_BLOCK_MS = 5 * 60_000;
// Strike keying PER PROVIDER CLASS. Antigravity's quota is genuinely
// per-model, so its key includes the model. Ollama/opencode free tiers meter
// the ACCOUNT — ollama's own 429 names the user ("you (lvoravit) have reached
// your monthly usage limit", no reset hint), so keying per model fragments the
// count across a multi-model combo: three different models on one connection
// would each be at strike 1 and nothing ever blocks. Key strike-only
// providers per connection (account-level). (review F2, seen live)
function strikeKey(providerId, connectionId, model) {
  return STRIKE_ONLY_PROVIDERS.has(providerId)
    ? `${connectionId}|*`           // account-level
    : `${connectionId}|${model}`;  // model-level (antigravity)
}
const strikeCounts = new Map(); // strikeKey → { count, windowStart (anchored at first strike) }
const strikeBlocks = new Map(); // strikeKey → blockedUntil ms

/** Providers whose 409/429s should be recorded here. Others use combo.js's text fallback. */
export function isQuotaTrackedProvider(providerId) {
  return QUOTA_API_PROVIDERS.has(providerId) || STRIKE_ONLY_PROVIDERS.has(providerId);
}

// Ollama Cloud and the opencode free tier both 429 with a plain "Rate limit
// exceeded" and no reset hint; the generic seconds/minutes backoff parks the
// account for a few seconds and the combo comes right back to it. Strike-only
// class: no quota API to consult — see STRIKE_ONLY_BLOCK_MS / strikeKey below
// for how they are handled. ("opencode-free" is defensive: the registry id is
// "opencode" — alias oc/zen resolve to it — so that entry can never match;
// kept for a future free-tier id split. review F5)
const STRIKE_KEY_SEP = "|";
const STRIKE_ONLY_PROVIDERS = new Set(["ollama", "opencode", "opencode-free"]);

function assertTracked(providerId) {
  if (!isQuotaTrackedProvider(providerId)) {
    throw new Error(`providerQuota: provider "${providerId}" is not quota-tracked`);
  }
}

/** Test-only: clear the quota cache, throttle bookkeeping and strike state. */
export function __resetProviderQuotaCache() {
  quotaCache.clear();
  lastRefreshAt.clear();
  inflightRefresh.clear();
  strikeCounts.clear();
  strikeBlocks.clear();
}

/**
 * Re-apply active strike blocks onto a fresh quotas snapshot so the auth
 * pre-filter (which reads this cache) keeps skipping the blocked pair across
 * requests until the block expires — same channel as the exhausted-0% path.
 */
function applyActiveStrikeBlocks(connectionId, quotas) {
  const now = Date.now();
  for (const [key, until] of strikeBlocks) {
    if (!key.startsWith(`${connectionId}${STRIKE_KEY_SEP}`)) continue;
    if (until <= now) {
      strikeBlocks.delete(key);
      continue;
    }
    quotas[key.slice(connectionId.length + 1)] = {
      remainingPercentage: 0,
      resetAt: new Date(until).toISOString(),
    };
  }
  return quotas;
}

/**
 * Clear strike state for a connection|model after a successful request, so
 * "consecutive" strikes means consecutive. Only removes a synthesized cache
 * entry (resetAt == our block deadline); a real upstream 0% reading stays.
 */
export function clearProviderStrikes(providerId, connectionId, model) {
  const key = strikeKey(providerId, connectionId, model);
  strikeCounts.delete(key);
  const until = strikeBlocks.get(key);
  if (until) {
    strikeBlocks.delete(key);
    const cached = quotaCache.get(connectionId);
    if (cached && cached[model]?.resetAt === new Date(until).toISOString()) {
      delete cached[model];
      if (Object.keys(cached).length === 0) quotaCache.delete(connectionId);
      else quotaCache.set(connectionId, cached);
      log.info("PQ", `${String(connectionId).slice(0, 8)} | strike cleared for ${model} after success`);
    }
  }
}

export function getProviderQuotaCache() {
  return quotaCache;
}

/**
 * Is this connection+model pair currently blocked by the quota cache or the
 * strike breaker? Returns the blocked-until epoch ms, or null. This is the
 * single lookup the auth pre-filter should use:
 *   - strike-only providers block at the ACCOUNT level (key `conn|*`), so
 *     every model on that connection is blocked once the account trips;
 *   - quota-API providers block per model (key `conn|model`), plus the cache's
 *     own exhausted-0% entry with its upstream resetAt.
 */
export function isPairBlocked(providerId, connectionId, model) {
  const now = Date.now();
  const key = strikeKey(providerId, connectionId, model);
  const blockedUntil = strikeBlocks.get(key);
  if (blockedUntil && blockedUntil > now) return blockedUntil;

  const quota = quotaCache.get(connectionId)?.[model];
  if (quota && quota.remainingPercentage <= 0 && quota.resetAt) {
    const resetMs = new Date(quota.resetAt).getTime();
    if (resetMs > now) return resetMs;
  }
  return null;
}

async function _doRefresh(connectionId, accessToken, providerSpecificData, now) {
  try {
    const proxyCfg = await resolveConnectionProxyConfig(providerSpecificData || {});
    const proxyOptions = {
      connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
      connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
      connectionNoProxy: proxyCfg.connectionNoProxy || "",
      vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
      strictProxy: proxyCfg.strictProxy === true,
    };

    const usage = await getAntigravityUsage(accessToken, providerSpecificData, proxyOptions);
    // 401/403 usage responses can contain an empty quotas object plus message.
    // Preserve known cache instead of replacing it with an upstream error response.
    if (!usage?.quotas || usage.message) return null;

    // Update in-memory cache. Caller logs CACHE_BLOCK only if the requested
    // model is exhausted. Strike blocks are re-asserted after every refresh so
    // an optimistic upstream reading cannot resurrect a pair we just broke.
    quotaCache.set(connectionId, applyActiveStrikeBlocks(connectionId, usage.quotas));

    return usage.quotas;
  } catch (e) {
    log.warn("PQ", `${String(connectionId).slice(0, 8)} | refresh failed: ${e.message}`);
    return null;
  }
}

export async function refreshProviderQuota(connectionId, accessToken, providerSpecificData) {
  const now = Date.now();
  // Coalesce concurrent refreshes before applying the interval gate.
  const inflight = inflightRefresh.get(connectionId);
  if (inflight) return inflight;

  const lastRefresh = lastRefreshAt.get(connectionId) || 0;
  if (now - lastRefresh < MIN_REFRESH_INTERVAL_MS) {
    log.debug("PQ", `${String(connectionId).slice(0, 8)} | skip refresh (${Math.round((now - lastRefresh) / 1000)}s ago)`);
    return quotaCache.get(connectionId) || null;
  }

  // Record every attempt so failed quota calls cannot amplify an upstream 429 burst.
  lastRefreshAt.set(connectionId, now);
  const promise = _doRefresh(connectionId, accessToken, providerSpecificData, now);
  inflightRefresh.set(connectionId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(connectionId);
  }
}

/**
 * Handle a 409/429 — refresh the RAM cache (when a quota API exists) and
 * return the model's resetAt when exhausted. Called from the chat handler's
 * error path BEFORE markAccountUnavailable so a long window reaches the
 * pre-filter through the cache instead of being capped by the persisted
 * modelLock_* (30min MAX_RATE_LIMIT_COOLDOWN_MS vs a real 80h window).
 *
 * @returns {number|null} resetAt timestamp ms (resetsAtMs passthrough) or null
 */
export async function handleProviderQuotaError(providerId, connectionId, status, model, accessToken, providerSpecificData) {
  assertTracked(providerId);
  log.info("PQ", `${String(connectionId).slice(0, 8)} | ${providerId} ${status} on ${model} — recording`);

  const hasQuotaApi = QUOTA_API_PROVIDERS.has(providerId);
  let quota = null;
  if (hasQuotaApi) {
    quota = (await refreshProviderQuota(connectionId, accessToken, providerSpecificData))?.[model] || null;
  }

  // Strike breaker: count every 429 whose quota reading is optimistic
  // (remaining > 0) or unavailable (no API / quota 403 / error). For
  // strike-only providers there is never a reading, so every 429 counts.
  // 409 counts too by design: antigravity signals pool exhaustion with 409 as
  // well, and poisoning by transient 409s requires 3 inside 60s on one pair.
  if (!quota || quota.remainingPercentage > 0) {
    const key = strikeKey(providerId, connectionId, model);
    const now = Date.now();
    const strike = strikeCounts.get(key);
    // Fixed window anchored at the FIRST qualifying strike: three 429s must
    // all land within 60s of that first one, not within 60s of each other.
    const windowStart = strike && now - strike.windowStart <= STRIKE_WINDOW_MS ? strike.windowStart : now;
    const count = strike && windowStart === strike.windowStart ? strike.count + 1 : 1;
    strikeCounts.set(key, { count, windowStart });
    if (count >= STRIKE_THRESHOLD) {
      strikeCounts.delete(key);
      const blockMs = hasQuotaApi ? STRIKE_BLOCK_MS : STRIKE_ONLY_BLOCK_MS;
      const blockedUntil = now + blockMs;
      const reading = quota ? `${Math.round(quota.remainingPercentage)}%` : "none";
      log.warn("PQ", `${String(connectionId).slice(0, 8)} | STRIKE_${status} ${providerId} ${model} — ${count}x (quota ${reading}); CACHE_BLOCK ${Math.round(blockMs / 60000)}m`);
      // Synthesize a 0% entry in the shared cache so the auth pre-filter skips
      // this pair on subsequent requests too — the chat handler does not
      // persist a modelLock_* for this path.
      const cached = quotaCache.get(connectionId) || {};
      cached[model] = { remainingPercentage: 0, resetAt: new Date(blockedUntil).toISOString() };
      quotaCache.set(connectionId, cached);
      strikeBlocks.set(key, blockedUntil);
      return blockedUntil;
    }
    return null;
  }

  // Healthy-but-exhausted reading: clear strikes and use the exact resetAt.
  // Via strikeKey(), not a hand-built key: this branch is only reachable for
  // quota-API providers today, but a hand-built model key would silently miss
  // the account key if a strike-only provider ever gained an API.
  strikeCounts.delete(strikeKey(providerId, connectionId, model));
  if (!quota.resetAt) return null;

  const resetMs = new Date(quota.resetAt).getTime();
  if (resetMs <= Date.now()) return null;

  log.warn("PQ", `${String(connectionId).slice(0, 8)} | UPSTREAM_${status} ${providerId} ${model} — quota exhausted; CACHE_BLOCK until ${quota.resetAt}`);
  return resetMs;
}
