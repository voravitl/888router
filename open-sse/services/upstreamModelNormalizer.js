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

const BOOLEAN_CAPABILITY_FIELDS = new Set([
  "vision",
  "pdf",
  "audioInput",
  "videoInput",
  "tools",
  "reasoning",
  "search",
]);
const NUMERIC_CAPABILITY_FIELDS = new Set(["contextWindow", "maxOutput"]);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidCapabilityValue(field, value) {
  if (BOOLEAN_CAPABILITY_FIELDS.has(field)) return typeof value === "boolean";
  if (NUMERIC_CAPABILITY_FIELDS.has(field)) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }
  if (field === "releasedAt") return typeof value === "string" && value.length > 0;
  return value !== undefined && value !== null;
}

function isNonNoneString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.toLowerCase() !== "none";
}

function hasAnyParam(paramSet, names) {
  if (!paramSet) return false;
  return names.some((name) => paramSet.has(name));
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
  if (isObject(value)) {
    if (typeof value.supported === "boolean") return value.supported;
    if (typeof value.enabled === "boolean") return value.enabled;
    if (typeof value.default_enabled === "boolean" && value.default_enabled) return true;
    if (typeof value.mandatory === "boolean" && value.mandatory) return true;
    if (Array.isArray(value.supported_efforts) && value.supported_efforts.length > 0) return true;
  }
  return undefined;
}

function modalityList(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function hasImage(list) {
  return list.some((x) => /^image(\/|$|\*)/i.test(String(x).trim()));
}

function hasPdf(list) {
  return list.some((x) => /^(application\/(x-)?pdf|pdf|file|document)$/i.test(String(x).trim()));
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
  const nestedLimits = isObject(raw.limit) ? raw.limit : {};
  const copilotLimits = isObject(nestedCaps.limits) ? nestedCaps.limits : {};
  const copilotSupports = isObject(nestedCaps.supports) ? nestedCaps.supports : {};
  const src = { ...nestedCaps, ...raw };

  let input = modalityList(
    src.modalities?.input,
    src.input_modalities,
    src.architecture?.input_modalities,
    src.modalities,
  );
  if (input.length === 0 && typeof src.architecture?.modality === "string") {
    const inputPart = src.architecture.modality.split("->")[0] || "";
    input = inputPart
      .split("+")
      .map((token) => token.trim())
      .filter(Boolean);
  }
  const supportedParams = Array.isArray(src.supported_parameters)
    ? new Set(src.supported_parameters.filter((p) => typeof p === "string").map((p) => p.trim()))
    : null;
  const delta = {};

  if (!raw.name) {
    const fallbackName =
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : typeof raw.displayName === "string" && raw.displayName.trim()
          ? raw.displayName.trim()
          : null;
    if (fallbackName) delta.name = fallbackName;
  }

  const contextWindow = firstNumber(
    nestedLimits.context,
    nestedLimits.context_window,
    nestedLimits.input,
    nestedLimits.max_input_tokens,
    src.context_length,
    src.max_context_window,
    src.context_window,
    src.contextWindow,
    src.contextLength,
    src.maxInputTokens,
    src.max_input_tokens,
    src.max_context_length,
    src.inputTokenLimit,
    src.input_token_limit,
    src.top_provider?.context_length,
    src.details?.context_length,
    copilotLimits.max_context_window_tokens,
    copilotLimits.max_prompt_tokens,
  );
  if (contextWindow !== undefined) {
    delta.contextWindow = contextWindow;
    // Mirror the spelling the dashboard + v1/models resolvers already read.
    delta.context_length = contextWindow;
  }

  const maxOutput = firstNumber(
    src.limit?.output,
    nestedLimits.max_output_tokens,
    nestedLimits.max_tokens,
    src.max_tokens,
    src.maxOutput,
    src.max_completion_tokens,
    src.maxOutputTokens,
    src.outputTokenLimit,
    src.output_token_limit,
    src.top_provider?.max_completion_tokens,
    copilotLimits.max_output_tokens,
  );
  if (maxOutput !== undefined) delta.maxOutput = maxOutput;

  let vision = firstBoolean(
    src.vision,
    src.supportsImages,
    src.supportsVision,
    src.attachment,
    booleanFromCap(nestedCaps.image_input),
    booleanFromCap(src.image_input),
    booleanFromCap(copilotSupports.vision),
  );
  if (vision === undefined) vision = familiesSayVision(src);
  if (vision === undefined && input.length > 0) vision = hasImage(input);
  if (vision !== undefined) delta.vision = vision;

  const pdf = firstBoolean(
    src.pdf,
    booleanFromCap(nestedCaps.pdf_input),
    booleanFromCap(src.pdf_input),
  ) ?? (input.length > 0 ? hasPdf(input) : undefined);
  if (pdf !== undefined) delta.pdf = pdf;

  const audioInput = firstBoolean(src.audioInput) ?? (input.length > 0 ? hasAudio(input) : undefined);
  if (audioInput !== undefined) delta.audioInput = audioInput;

  const videoInput = firstBoolean(src.videoInput) ?? (input.length > 0 ? hasVideo(input) : undefined);
  if (videoInput !== undefined) delta.videoInput = videoInput;

  const reasoning = firstBoolean(
    booleanFromCap(nestedCaps.reasoning),
    booleanFromCap(src.reasoning),
    booleanFromCap(nestedCaps.thinking),
    booleanFromCap(src.thinking),
    booleanFromCap(copilotSupports.thinking),
    typeof copilotLimits.max_thinking_budget === "number" && copilotLimits.max_thinking_budget > 0 ? true : undefined,
    Array.isArray(src.thinking) ? src.thinking.length > 0 : undefined,
    hasAnyParam(supportedParams, ["reasoning", "include_reasoning", "reasoning_effort", "thinking"]) ? true : undefined,
    (Array.isArray(src.supported_reasoning_levels) && src.supported_reasoning_levels.length > 0) ||
      isNonNoneString(src.default_reasoning_level)
      ? true
      : undefined,
  );
  if (reasoning !== undefined) delta.reasoning = reasoning;

  const tools = firstBoolean(
    booleanFromCap(nestedCaps.tools),
    booleanFromCap(src.tools),
    booleanFromCap(copilotSupports.tool_calls),
    booleanFromCap(copilotSupports.parallel_tool_calls),
    hasAnyParam(supportedParams, ["tools", "tool_choice", "functions"]) ? true : undefined,
    src.supports_parallel_tool_calls === true ||
      isNonNoneString(src.apply_patch_tool_type) ||
      src.toolCalling === true
      ? true
      : undefined,
  );
  if (tools !== undefined) delta.tools = tools;

  const search = firstBoolean(
    src.search,
    src.web_search,
    booleanFromCap(nestedCaps.search),
    booleanFromCap(nestedCaps.server_tools?.web_search),
    hasAnyParam(supportedParams, ["web_search", "web_search_options"]) ? true : undefined,
    isNonNoneString(src.web_search_tool_type) ? true : undefined,
  );
  if (search !== undefined) delta.search = search;

  const releasedAt = toIsoDate(src.release_date ?? src.created_at ?? src.created);
  if (releasedAt !== undefined) delta.releasedAt = releasedAt;

  const out = { ...raw, ...delta };
  for (const field of NORMALIZED_CAPABILITY_FIELDS) {
    if (field in out && !isValidCapabilityValue(field, out[field])) {
      delete out[field];
    }
  }
  return out;
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
    if (isValidCapabilityValue(field, value)) {
      out[field] = value;
    }
  }
  return out;
}
