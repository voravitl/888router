import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function entryKey(connectionId, modelId) {
  return `${connectionId}:${modelId}`;
}

export async function getSyncedModelsMap() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'syncedModels'`);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, {});
  return out;
}

// entries: [{ connectionId, modelId }]
// Returns the map of just-stamped keys → { lastSyncedAt, firstSeenAt, status: "active" }.
// `options.now` lets tests pin the clock; `options.status` is an escape hatch
// (normal syncs always stamp "active").
export async function stampSyncedModels(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return {};
  const db = await getAdapter();
  const now = options?.now || new Date().toISOString();
  const status = options?.status || "active";
  const stamped = {};

  db.transaction(() => {
    for (const { connectionId, modelId } of entries) {
      if (!connectionId || !modelId) continue;
      const key = entryKey(connectionId, modelId);
      const row = db.get(`SELECT value FROM kv WHERE scope = 'syncedModels' AND key = ?`, [key]);
      const existing = row ? parseJson(row.value, {}) : {};
      const firstSeenAt = existing.firstSeenAt || now;
      const value = { lastSyncedAt: now, firstSeenAt, status };
      // A model seen again is live again: clear the ghost marker from a prior
      // failed sync. Deleting (rather than setting null) keeps old rows clean.
      delete value.missingSince;
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('syncedModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [key, stringifyJson(value)]
      );
      stamped[key] = value;
    }
  });

  return stamped;
}

/**
 * Lifecycle reconciliation for one connection. A successful live sync declares
 * exactly which model ids are active; anything previously active for the same
 * connection that is absent becomes `stale` with a `missingSince` timestamp.
 *
 * Stale rows are NEVER deleted: combos/aliases that still reference a retired
 * upstream id keep resolving instead of breaking outright. A failed/empty
 * upstream response must never run this — pass a non-empty `activeModelIds`
 * only when the live fetch actually succeeded.
 *
 * @returns {Record<string, object>} the keys that transitioned to stale
 */
export async function reconcileSyncedModelsForConnection(connectionId, activeModelIds, options = {}) {
  if (!connectionId || !Array.isArray(activeModelIds) || activeModelIds.length === 0) return {};
  const db = await getAdapter();
  const now = options?.now || new Date().toISOString();
  const prefix = `${connectionId}:`;
  const active = new Set(activeModelIds.map(String));
  const changed = {};

  db.transaction(() => {
    const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'syncedModels'`);
    for (const row of rows) {
      if (typeof row?.key !== "string" || !row.key.startsWith(prefix)) continue;
      const modelId = row.key.slice(prefix.length);
      if (active.has(modelId)) continue;
      const existing = parseJson(row.value, {});
      // Already-stale ghosts keep their original missingSince — do not refresh
      // the clock on every sync or they never look "long missing".
      if (existing.status === "stale") continue;
      const value = { ...existing, status: "stale", missingSince: existing.missingSince || now };
      db.run(
        `UPDATE kv SET value = ? WHERE scope = 'syncedModels' AND key = ?`,
        [stringifyJson(value), row.key]
      );
      changed[row.key] = value;
    }
  });

  return changed;
}

export async function upsertSyncedModel(connectionId, modelId) {
  return await stampSyncedModels([{ connectionId, modelId }]);
}

/**
 * Dynamic Capabilities Repo
 * Stores & reads model capabilities extracted dynamically from provider sync APIs or online lookup.
 *
 * Keys are scoped `providerId:modelId` so one provider's synced capabilities cannot bleed
 * into the same model id on another connection (review finding #5). Rows persisted by older
 * builds under a bare model id are still read as a legacy fallback.
 */
function capabilityKey(providerId, modelId) {
  const baseId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  return providerId ? `${providerId}:${baseId}` : baseId;
}

export async function getModelDynamicCapabilities(providerId, modelId) {
  if (!modelId) return null;
  const scoped = capabilityKey(providerId, modelId);
  const db = await getAdapter();
  let row = db.get(`SELECT value FROM kv WHERE scope = 'modelCapabilities' AND key = ?`, [scoped]);
  if (!row && providerId) {
    // Legacy bare-key rows (pre-scoped builds)
    row = db.get(`SELECT value FROM kv WHERE scope = 'modelCapabilities' AND key = ?`, [modelId.split("/").pop()]);
  }
  if (!row) return null;
  return parseJson(row.value, null);
}

/**
 * Bulk-read all synced dynamic capabilities into a Map keyed by the raw row
 * key (`providerId:baseId`, or legacy bare `baseId`). Lets /v1/models lay the
 * synced context over the static catalogue in one query instead of a
 * round-trip per model; the caller matches provider+model against the key.
 */
export async function getAllModelDynamicCapabilities() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = 'modelCapabilities'`);
  const out = new Map();
  for (const r of rows) {
    const caps = parseJson(r.value, null);
    if (!caps || typeof caps !== "object") continue;
    const cw = caps.contextWindow;
    // Reject a malformed context window at the read boundary — a bad/zero/
    // negative/gateway-`1` value must not permanently override the static
    // catalogue. Rows that carry NO context window (vision-only syncs) are
    // valid: they simply contribute modality/feature fields. Validating only
    // rows that DO carry the field keeps the bad-cache-row guard intact while
    // letting the expanded capability set through.
    if (cw !== undefined && cw !== null && (!Number.isFinite(cw) || cw <= 1)) continue;
    // Strip the persistence timestamp — it is repo metadata, not a capability,
    // and leaking it into /v1/models model.capabilities pollutes the payload.
    const { updatedAt, ...clean } = caps;
    out.set(r.key, clean);
  }
  return out;
}

export async function saveModelDynamicCapabilities(providerId, modelId, caps) {
  if (!modelId || !caps) return;
  const key = capabilityKey(providerId, modelId);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const value = { ...caps, updatedAt: now };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES('modelCapabilities', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [key, stringifyJson(value)]
  );
}
