/**
 * Pure helper for model matching in search queries
 * Supports tokenized matching and space/hyphen normalization
 */
export function matchesModelSearch(model, query, providerName = "", providerId = "") {
  if (!query) return true;
  const q = String(query).trim().toLowerCase();
  if (!q) return true;

  const pName = (providerName || "").toLowerCase();
  const pId = (providerId || "").toLowerCase();
  if (pName.includes(q) || pId.includes(q)) return true;

  const mName = (model?.name || "").toLowerCase();
  const mId = (model?.id || "").toLowerCase();
  const mValue = (model?.value || "").toLowerCase();

  // Fast path: literal match in name, id, or value
  if (mName.includes(q) || mId.includes(q) || mValue.includes(q)) return true;

  // Tokenized match: "space bunny free" matches "space-bunny-free" or "oc/space-bunny-free"
  const tokens = q.split(/[\s\-_/]+/).filter(Boolean);
  if (tokens.length > 0) {
    const fullSearchable = `${mName} ${mId} ${mValue} ${pName} ${pId}`.replace(/[\-_/]/g, " ");
    return tokens.every((t) => fullSearchable.includes(t));
  }

  return false;
}
