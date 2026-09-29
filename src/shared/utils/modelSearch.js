/**
 * Pure helper for model matching in search queries
 * Supports tokenized matching and space/hyphen normalization
 */
// Recognise context-size keywords typed straight into search ("1m", "200k",
// "500k", "128k") so users can find a 1M-context model by typing 1m — the
// same shorthand the context filter dropdown uses (≥ 128K / ≥ 200K / ≥ 1M).
const CONTEXT_KEYWORDS = [
  { re: /^(1m|1000k|1048k|1048756|1048576)$/, min: 1_000_000 },
  { re: /^500k$/, min: 500_000 },
  { re: /^(272k|256k|262k)$/, min: 256_000 },
  { re: /^(200k|204800|196608)$/, min: 200_000 },
  { re: /^(128k|131k|131072|132k)$/, min: 128_000 },
];

/**
 * Returns the minimum context window implied by a context-size keyword in the
 * query, or null when the query is not a context keyword.
 */
export function contextKeywordMin(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  for (const { re, min } of CONTEXT_KEYWORDS) {
    if (re.test(q)) return min;
  }
  return null;
}

/**
 * Split a query into (textTokens, ctxMin): a context keyword token acts as a
 * predicate, the remaining tokens stay text. "flash 1m" → text ["flash"],
 * ctx ≥ 1,000,000 — so compound queries find 1M-context flash models instead
 * of returning an empty list (the pure-keyword case is handled by
 * contextKeywordMin on the whole query).
 */
export function splitContextQuery(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { text: "", ctxMin: null };
  if (contextKeywordMin(q) != null) return { text: "", ctxMin: contextKeywordMin(q) };
  const tokens = q.split(/[\s\-_/]+/).filter(Boolean);
  let ctxMin = null;
  const text = [];
  for (const t of tokens) {
    const kw = contextKeywordMin(t);
    if (kw != null && ctxMin == null) ctxMin = kw;
    else text.push(t);
  }
  return { text: text.join(" "), ctxMin };
}

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
