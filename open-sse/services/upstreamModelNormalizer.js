/**
 * Shared upstream-model normalization for dynamic model sync.
 *
 * Upstreams disagree on how a model describes itself: OpenCode Go's
 * `/zen/go/v1/models` sends `modalities.input` MIME types plus a `limit` block,
 * Codex sends `max_context_window` + `input_modalities`, others send a bare
 * `vision` boolean. This module folds every spelling into one canonical set of
 * capability fields so the sync endpoint, `/api/models`, `/v1/models` and
 * `/v1/models/info` all agree on what a synced model can do.
 *
 * Pure and provider-agnostic: no DB, no network, no mutation of the input.
 */

/** Capability fields persisted to `modelCapabilities` and surfaced to clients. */
export const NORMALIZED_CAPABILITY_FIELDS = [
  "contextWindow",
  "maxOutput",
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "tools",
  "reasoning",
  "search",
  "releasedAt",
];

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function booleanFromCap(value) {
  if (typeof value === "boolean") return value;
  if (isObject(value) && typeof value.supported === "boolean") return value.supported;
  return undefined;
}

function modalityList(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function hasImage(list) {
  return list.some((x) => /^image(\/|$|\*)/i.test(String(x).trim()));
}

function hasPdf(list) {
  return list.some((x) => /^(application\/(x-)?pdf|pdf)$/i.test(String(x).trim()));
}

function hasAudio(list) {
  return list.some((x) => /^audio(\/|$|\*)/i.test(String(x).trim()));
}

function hasVideo(list) {
  return list.some((x) => /^video(\/|$|\*)/i.test(String(x).trim()));
}

function familiesSayVision(raw) {
  const families = raw?.details?.families;
  if (!Array.isArray(families)) return undefined;
  return families.some((f) => /vision/i.test(String(f)));
}

function toIsoDate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds is the upstream convention; tolerate millisecond values too.
    const ms = Math.abs(value) > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return toIsoDate(Number(trimmed));
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/**
 * Normalize one raw upstream catalog entry into the canonical capability shape,
 * merged over the original fields. Fields the upstream does not state are left
 * absent so callers (models.dev enrichment, static catalogue) can still fill
 * them without an explicit `undefined` shadowing their answer.
 *
 * @param {string} providerId provider id of the connection (part of the shared
 *   contract; kept so provider-specific quirks have a seam)
 * @param {object} raw raw model entry from an upstream `/models` response
 * @returns {object} a new model object with normalized fields merged on
 */
export function normalizeUpstreamModel(providerId, raw) {
  // Kept in the signature deliberately: every caller passes its connection's
  // provider id, and normalization is provider-agnostic today.
  void providerId;
  if (!isObject(raw)) return raw;

  // Some resolvers (opencode-go live catalog) hang the truth under
  // `capabilities`; top-level fields always win over that nested block.
  const nestedCaps = isObject(raw.capabilities) ? raw.capabilities : {};
  const src = { ...nestedCaps, ...raw };

  const input = modalityList(src.modalities?.input, src.input_modalities, src.modalities);
  const delta = {};

  const contextWindow = firstNumber(
    src.limit?.context,
    src.context_length,
    src.max_context_window,
    src.context_window,
    src.contextWindow,
    src.maxInputTokens,
    src.details?.context_length,
  );
  if (contextWindow !== undefined) {
    delta.contextWindow = contextWindow;
    // Mirror the spelling the dashboard + v1/models resolvers already read.
    delta.context_length = contextWindow;
  }

  const maxOutput = firstNumber(
    src.limit?.output,
    src.max_tokens,
    src.maxOutput,
    src.max_completion_tokens,
    src.maxOutputTokens,
  );
  if (maxOutput !== undefined) delta.maxOutput = maxOutput;

  let vision = firstBoolean(
    src.vision,
    src.supportsImages,
    src.supportsVision,
    src.attachment,
  );
  if (vision === undefined) vision = familiesSayVision(src);
  if (vision === undefined && input.length > 0) vision = hasImage(input);
  if (vision !== undefined) delta.vision = vision;

  const pdf = firstBoolean(src.pdf) ?? (input.length > 0 ? hasPdf(input) : undefined);
  if (pdf !== undefined) delta.pdf = pdf;

  const audioInput = firstBoolean(src.audioInput) ?? (input.length > 0 ? hasAudio(input) : undefined);
  if (audioInput !== undefined) delta.audioInput = audioInput;

  const videoInput = firstBoolean(src.videoInput) ?? (input.length > 0 ? hasVideo(input) : undefined);
  if (videoInput !== undefined) delta.videoInput = videoInput;

  const reasoning = firstBoolean(
    booleanFromCap(nestedCaps.reasoning),
    booleanFromCap(src.reasoning),
  ) ?? (Array.isArray(src.thinking) ? src.thinking.length > 0 : firstBoolean(src.thinking));
  if (reasoning !== undefined) delta.reasoning = reasoning;

  const tools = firstBoolean(booleanFromCap(nestedCaps.tools), booleanFromCap(src.tools));
  if (tools !== undefined) delta.tools = tools;

  const search = firstBoolean(src.search, src.web_search, nestedCaps.search);
  if (search !== undefined) delta.search = search;

  const releasedAt = toIsoDate(src.release_date ?? src.created_at ?? src.created);
  if (releasedAt !== undefined) delta.releasedAt = releasedAt;

  return { ...raw, ...delta };
}

/**
 * Pick only the canonical capability fields off a normalized model. Used when
 * persisting `modelCapabilities` rows and when lifting live catalog metadata
 * into the `capabilities` sub-object `/v1/models` reads.
 */
export function collectNormalizedCapabilities(model) {
  if (!isObject(model)) return {};
  const out = {};
  for (const field of NORMALIZED_CAPABILITY_FIELDS) {
    const value = model[field];
    if (value === undefined || value === null) continue;
    out[field] = value;
  }
  return out;
}
