// Pure helpers for model capability resolution and synced-model lifecycle.
// Kept free of React/next imports so the rules can be unit-tested in isolation.

export const CAP_FIELDS = [
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "tools",
  "reasoning",
  "search",
  "contextWindow",
  "maxOutput",
];

const BOOLEAN_CAP_FIELDS = new Set([
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "tools",
  "reasoning",
  "search",
]);
const NUMERIC_CAP_FIELDS = new Set(["contextWindow", "maxOutput"]);

const hasOwn = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

function firstPositiveNumber(...values) {
  for (const val of values) {
    if (val === undefined || val === null || val === "" || typeof val === "boolean" || typeof val === "object") {
      continue;
    }
    const n = typeof val === "number" ? val : Number(val);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function pickNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return "";
}

// Copy only concrete, type-valid cap values. `false` is meaningful (an explicit
// "no vision") and must survive; undefined/null/malformed types mean "not stated"
// and are dropped.
export function pickCaps(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out = {};
  for (const field of CAP_FIELDS) {
    if (!hasOwn(source, field)) continue;
    const val = source[field];
    if (BOOLEAN_CAP_FIELDS.has(field)) {
      if (typeof val === "boolean") out[field] = val;
    } else if (NUMERIC_CAP_FIELDS.has(field)) {
      if (typeof val === "number" && Number.isFinite(val) && val > 0) out[field] = val;
    }
  }
  return out;
}

// First source that states a field wins. Sources are ordered high → low priority.
export function mergeCapsPreferFirst(...sources) {
  const out = {};
  for (const source of sources) {
    const picked = pickCaps(source);
    for (const field of CAP_FIELDS) {
      if (!hasOwn(out, field) && hasOwn(picked, field)) out[field] = picked[field];
    }
  }
  return out;
}

export function getBareModelId(key) {
  if (typeof key !== "string" || !key) return "";
  const slash = key.indexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}

// Build the lookup used by useModelCaps. Dynamic caps are ingested first so a
// scoped "provider/model" entry can never be overwritten by a bare static ID.
export function buildCapsIndexes(payload = {}) {
  const byFull = {};
  const byId = {};
  const dynamic = payload.dynamicCapsByKey || {};

  for (const [key, value] of Object.entries(dynamic)) {
    if (!key) continue;
    const picked = pickCaps(value);
    if (Object.keys(picked).length === 0) continue;
    byFull[key] = { ...(byFull[key] || {}), ...picked };
    if (!key.includes("/")) byId[key] = { ...(byId[key] || {}), ...picked };
  }

  for (const model of payload.models || []) {
    if (!model || typeof model !== "object") continue;
    const picked = pickCaps(model.caps && typeof model.caps === "object" ? model.caps : model);
    if (Object.keys(picked).length === 0) continue;
    const full = model.fullModel || model.full_model;
    if (full && typeof full === "string") {
      // Existing (dynamic) values win over values coming from a static row.
      byFull[full] = { ...picked, ...(byFull[full] || {}) };
    }
    const bare = model.model || model.id;
    if (bare && typeof bare === "string" && !bare.includes("/")) {
      byId[bare] = { ...picked, ...(byId[bare] || {}) };
    }
  }

  return { byFull, byId };
}

// Merge priority: explicit modelOverride > scoped dynamic (canonical key) >
// scoped dynamic (alias key) > bare static ID > client catalogue fallback.
export function resolveModelCaps({
  key,
  aliasKey = null,
  modelOverride = null,
  byFull = {},
  byId = {},
  fallbackFor = null,
} = {}) {
  if (!key || typeof key !== "string") return null;
  const bare = getBareModelId(key);
  const slash = key.indexOf("/");
  const provider = slash > 0 ? key.slice(0, slash) : null;
  const fallback = typeof fallbackFor === "function" ? pickCaps(fallbackFor(provider, bare)) : {};
  return mergeCapsPreferFirst(
    modelOverride,
    byFull[key],
    aliasKey ? byFull[aliasKey] : null,
    bare ? byId[bare] : null,
    fallback
  );
}

// Normalize a row from GET /api/providers/[id]/models without losing the caps
// the upstream reported — they drive the badges and the Vision filter.
// Bare upstream rows fall back to `fallbackCaps` / `fallbackName` while letting
// any valid upstream value (including explicit `false`) win.
export function normalizeSyncModel(item, fallbackCaps = null, fallbackName = null) {
  if (!item) return null;
  const resolvedFallbackCaps = pickCaps(fallbackCaps);
  const resolvedFallbackName = pickNonEmptyString(fallbackName);

  if (typeof item === "string") {
    const hasFallbackCaps = Object.keys(resolvedFallbackCaps).length > 0;
    const fallbackMaxInput = resolvedFallbackCaps.contextWindow;
    if (!hasFallbackCaps && !resolvedFallbackName) return { id: item, name: item };
    return {
      id: item,
      name: resolvedFallbackName || item,
      ...resolvedFallbackCaps,
      ...(fallbackMaxInput ? { maxInputTokens: fallbackMaxInput } : {}),
    };
  }

  if (typeof item !== "object" || Array.isArray(item)) return null;
  const id = pickNonEmptyString(item.id, item.modelId, item.model, item.name);
  if (!id) return null;

  const rawCaps = item.caps && typeof item.caps === "object" && !Array.isArray(item.caps) ? item.caps : item;
  const upstreamCaps = pickCaps(rawCaps);
  const upstreamContextWindow = firstPositiveNumber(
    item.maxInputTokens,
    item.max_input_tokens,
    item.max_context_window,
    item.context_window,
    item.contextLength,
    item.contextWindow,
    item.context_length,
    item.top_provider?.context_length,
    item.details?.context_length,
    upstreamCaps.contextWindow
  );
  // Keep any upstream context spelling (e.g. max_input_tokens) ahead of
  // fallbackCaps.contextWindow so catalogue guesses never mask real limits.
  const caps = mergeCapsPreferFirst(
    upstreamCaps,
    upstreamContextWindow !== undefined
      ? { ...resolvedFallbackCaps, contextWindow: upstreamContextWindow }
      : resolvedFallbackCaps
  );
  const maxInputTokens = upstreamContextWindow ?? resolvedFallbackCaps.contextWindow ?? 0;

  const rawName = pickNonEmptyString(item.name, item.modelName, item.displayName, item.display_name);
  const name = (rawName && rawName !== id ? rawName : "") || resolvedFallbackName || rawName || id;

  return {
    id,
    name,
    description: item.description || "",
    ...caps,
    ...(Number.isFinite(maxInputTokens) && maxInputTokens > 0 ? { maxInputTokens } : {}),
    ...(caps.contextWindow === undefined && Number.isFinite(maxInputTokens) && maxInputTokens > 0
      ? { contextWindow: maxInputTokens }
      : {}),
    ...(item.status ? { status: item.status } : {}),
  };
}

export function filterSyncModels(models = [], { query = "", filterTab = "all", existingIds = [] } = {}) {
  const existing = new Set(existingIds);
  const term = String(query || "").trim().toLowerCase();
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (!model) return false;
    const isAdded = existing.has(model.id);
    if (filterTab === "available" && isAdded) return false;
    if (filterTab === "added" && !isAdded) return false;
    if (filterTab === "vision" && !model.vision) return false;
    if (!term) return true;
    return [model.id, model.name, model.description].some((value) =>
      String(value || "").toLowerCase().includes(term)
    );
  });
}

// A live catalog is the only thing that may declare a model stale. If the
// upstream sync failed or returned nothing, every row stays active and visible.
export function classifyModelStatus(row, { liveIdSet, hasLiveCatalog, missingSince = null } = {}) {
  if (!hasLiveCatalog) return { status: "active", missingSince: null };
  if (row?.status === "stale") {
    return { status: "stale", missingSince: row.missingSince || missingSince || null };
  }
  // Explicitly user-created rows (including aliases) are protected — never
  // mark them retired just because the upstream catalog changed.
  if ((row?.source === "custom" || row?.source === "legacyAlias") && !row.autoSynced) {
    return { status: "active", missingSince: null };
  }
  if (!liveIdSet || !liveIdSet.has(row?.id)) {
    return { status: "stale", missingSince: row?.missingSince || missingSince || null };
  }
  return { status: "active", missingSince: null };
}

export function partitionModelsByStatus(rows = []) {
  const active = [];
  const stale = [];
  for (const row of rows || []) {
    if (row?.status === "stale") stale.push(row);
    else active.push(row);
  }
  return { active, stale };
}
