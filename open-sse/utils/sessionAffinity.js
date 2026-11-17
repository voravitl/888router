import { resolveConversationAffinityId } from "./sessionManager.js";

const MAX_AFFINITY_ENTRIES = 2000;
const AFFINITY_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

if (!globalThis._chatSessionAffinityStore) {
  globalThis._chatSessionAffinityStore = new Map();
}
const affinityStore = globalThis._chatSessionAffinityStore;

if (!globalThis._chatSessionAffinityCleanupTimer) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of affinityStore) {
      if (now - entry.lastUsed > AFFINITY_TTL_MS) {
        affinityStore.delete(k);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();
  globalThis._chatSessionAffinityCleanupTimer = timer;
}

/**
 * Derive a provider-scoped affinity key only when the request identifies a
 * real conversation (explicit session header/field or multi-turn assistant
 * history). Returns null for stateless single-turn requests.
 */
export function resolveChatSessionAffinityKey({ headers, body, provider } = {}) {
  const scope = typeof provider === "string" ? provider : "";
  const sessionKey = resolveConversationAffinityId({ headers, body, scope });
  if (!sessionKey) return null;
  return `${scope || "default"}:${sessionKey}`;
}

/**
 * Look up a still-valid pinned connectionId that is not excluded during
 * failover. Refreshes LRU recency on hit.
 */
export function getPinnedConnection(affinityKey, excludeConnectionIds = null) {
  if (!affinityKey) return null;
  const entry = affinityStore.get(affinityKey);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.lastUsed > AFFINITY_TTL_MS) {
    affinityStore.delete(affinityKey);
    return null;
  }

  if (excludeConnectionIds && excludeConnectionIds.has(entry.connectionId)) {
    return null;
  }

  entry.lastUsed = now;
  affinityStore.delete(affinityKey);
  affinityStore.set(affinityKey, entry);
  return entry.connectionId;
}

/**
 * Record a successful connection for this conversation affinity key.
 */
export function pinConnection(affinityKey, connectionId) {
  if (!affinityKey || !connectionId) return;
  if (affinityStore.has(affinityKey)) {
    affinityStore.delete(affinityKey);
  } else if (affinityStore.size >= MAX_AFFINITY_ENTRIES) {
    const oldest = affinityStore.keys().next().value;
    if (oldest !== undefined) affinityStore.delete(oldest);
  }
  affinityStore.set(affinityKey, { connectionId, lastUsed: Date.now() });
}

export function clearAffinityStore() {
  affinityStore.clear();
}
