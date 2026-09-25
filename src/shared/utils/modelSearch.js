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

  // If the query matches the provider name or id as a whole phrase, show all its models
  if (pName.includes(q) || pId.includes(q)) return true;

  const mName = (model?.name || "").toLowerCase();
  const mId = (model?.id || "").toLowerCase();
  const mValue = (model?.value || "").toLowerCase();

  // Fast path: literal match in name, id, or value
  if (mName.includes(q) || mId.includes(q) || mValue.includes(q)) return true;

  // Tokenized match:
  const tokens = q.split(/[\s\-_/]+/).filter(Boolean);
  if (tokens.length > 0) {
    // 1) Match tokens entirely within the model identity (name, id, value)
    const modelSearchable = `${mName} ${mId} ${mValue}`.replace(/[\-_/]/g, " ");
    if (tokens.every((t) => modelSearchable.includes(t))) return true;

    // 2) Or match tokens within the explicit provider/model path (e.g. "oc space bunny")
    const pathSearchable = `${pId} ${pName} ${mId} ${mName}`.replace(/[\-_/]/g, " ");
    const matchesModelPart = tokens.some((t) => modelSearchable.includes(t));
    if (matchesModelPart && tokens.every((t) => pathSearchable.includes(t))) return true;
  }

  return false;
}
