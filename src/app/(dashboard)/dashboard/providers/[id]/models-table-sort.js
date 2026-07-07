// Pure comparator extracted from ModelsTable.js so it can be imported by unit
// tests without pulling JSX through vitest's node environment (which has no JSX
// plugin). Re-exported from ModelsTable.js for component consumers.
//
// Sortable fields: "lastSyncedAt" | "name" | "context".
// Null lastSyncedAt sorts LAST under both asc and desc.
// Tie-break: model.id ascending (stable).
export function compareModels(a, b, field, order) {
  const dir = order === "asc" ? 1 : -1;
  let cmp = 0;

  if (field === "lastSyncedAt") {
    const ta = a.lastSyncedAt ? Date.parse(a.lastSyncedAt) || 0 : null;
    const tb = b.lastSyncedAt ? Date.parse(b.lastSyncedAt) || 0 : null;
    if (ta === null && tb === null) cmp = 0;
    else if (ta === null) return 1;   // null always last
    else if (tb === null) return -1;
    else cmp = (ta - tb) * dir;
  } else if (field === "name") {
    const na = (a.name || a.id || "").toLowerCase();
    const nb = (b.name || b.id || "").toLowerCase();
    cmp = na.localeCompare(nb) * dir;
  } else if (field === "context") {
    const ca = a.maxInputTokens || a.contextLength || 0;
    const cb = b.maxInputTokens || b.contextLength || 0;
    cmp = (ca - cb) * dir;
  }

  if (cmp !== 0) return cmp;
  // Stable tie-break on id ascending.
  const ida = (a.id || "").toString();
  const idb = (b.id || "").toString();
  return ida.localeCompare(idb);
}
