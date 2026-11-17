// Codex auto-generates a "-review" variant for each llm model (review quota family)
export const CODEX_REVIEW_SUFFIX = "-review";

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if ((model.kind || model.type || "llm") !== "llm" || model.id.endsWith(CODEX_REVIEW_SUFFIX)) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review"
      }
    ];
  });
}

// Canonicalize only the provider's spelling. An explicit model version must
// reach upstream unchanged: substituting an older model hides its identity and
// borrows capabilities the requested model has not demonstrated.
export function resolveAntigravityFlashModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return modelId;
  const match = modelId.match(/^gemini-(\d+)(?:\.(\d+))?-flash(?:-(high|medium|low))?$/i);
  if (!match) return modelId;
  const version = match[1] + (match[2] !== undefined ? `.${match[2]}` : "");
  const tier = match[3] ? `-${match[3].toLowerCase()}` : "";
  return `gemini-${version}-flash${tier}`;
}

const HYDROGEN_TIERS = new Set(["xhigh", "high", "medium", "low"]);

/**
 * Resolve Gemini 4 Hydrogen aliases (including cached -tiered / -tiered-<level>)
 * to canonical "gemini-4-hydrogen(<level>)" so Antigravity receives wire model
 * "gemini-4-hydrogen" + matching thinkingLevel.
 */
export function resolveAntigravityHydrogenModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return modelId;
  const match = modelId.trim().match(/^gemini-4-hydrogen(?:-tiered)?(?:-(xhigh|high|medium|low))?$/i);
  if (!match) return modelId;
  const tier = match[1] ? match[1].toLowerCase() : "high";
  return `gemini-4-hydrogen(${HYDROGEN_TIERS.has(tier) ? tier : "high"})`;
}

// Antigravity retired/unroutable live-API patterns to exclude from /v1/models and sync.
// Note: gemini-3.5-flash-low and gemini-3-flash-agent are intentionally omitted here so
// existing live-resolver fixture tests keep their contract; retired 3.6/3.7/3.1-pro are blocked.
const ANTIGRAVITY_RETIRED_OR_JUNK_INPUT_PATTERNS = [
  /^tab[_-]/i,                    // tab-autocomplete: tab_jump_flash_lite_preview, tab_flash_lite_preview
  /[-_]disabled(?:[-_]|$)/i,      // e.g. gemini-4-carbon-disabled
  /[-_]sonar(?:[-_]|$)/i,         // e.g. gemini-4-hydrogen-sonar
  /^gemini-3\.6-flash(?:-|$)/i,   // retired 404
  /^gemini-3\.7-flash(?:-|$)/i,   // retired 404
  /^gemini-3\.1-pro(?:-|$)/i,     // retired 404
  /^gemini-3\.5-flash-extra-low$/i,
  /^gemini-pro-agent$/i,
];

const ANTIGRAVITY_TIERED_SUFFIX_RE = /-tiered(?:-|$)/i;

/** Return true for Antigravity internal, tab-autocomplete, disabled, sonar, retired, or raw -tiered/-tiered-* IDs. */
export function isAntigravityHiddenModel(modelId) {
  if (typeof modelId !== "string") return true;
  const trimmed = modelId.trim();
  if (!trimmed) return true;
  return (
    ANTIGRAVITY_RETIRED_OR_JUNK_INPUT_PATTERNS.some((re) => re.test(trimmed))
    || ANTIGRAVITY_TIERED_SUFFIX_RE.test(trimmed)
  );
}

function expandAntigravityLiveModel(id, displayName) {
  if (typeof id !== "string") return [];
  const trimmed = id.trim();
  if (!trimmed) return [];
  if (ANTIGRAVITY_RETIRED_OR_JUNK_INPUT_PATTERNS.some((re) => re.test(trimmed))) return [];

  if (/^gemini-4-hydrogen-tiered$/i.test(trimmed)) {
    return [
      { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
      { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
      { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
      { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
    ];
  }

  const flashMatch = trimmed.match(/^(gemini-[\d.]+-flash)-tiered$/i);
  if (flashMatch) {
    const prefix = flashMatch[1].toLowerCase();
    const ver = prefix.replace("gemini-", "").replace("-flash", "");
    return [
      { id: `${prefix}-high`, name: `Gemini ${ver} Flash (High)` },
      { id: `${prefix}-medium`, name: `Gemini ${ver} Flash (Medium)` },
      { id: `${prefix}-low`, name: `Gemini ${ver} Flash (Low)` },
    ];
  }

  if (ANTIGRAVITY_TIERED_SUFFIX_RE.test(trimmed)) return [];
  return [{ id: trimmed, name: displayName || trimmed }];
}

/**
 * Parse, filter, expand, and deduplicate Antigravity :fetchAvailableModels payloads,
 * merging static Gemini 3/4 registry entries cleanly.
 */
export function parseAntigravityLiveModels(data, staticModels = []) {
  const rawModels = data?.models;
  const hasEntries = Array.isArray(rawModels)
    ? rawModels.length > 0
    : Boolean(rawModels && typeof rawModels === "object" && Object.keys(rawModels).length > 0);
  if (!hasEntries) return [];

  let expanded = [];
  if (Array.isArray(rawModels)) {
    expanded = rawModels.flatMap((item) => {
      if (!item || item.isInternal || item.disabled === true) return [];
      const id = item.id || item.model || item.name;
      if (!id) return [];
      return expandAntigravityLiveModel(id, item.displayName || item.name || id);
    });
  } else {
    expanded = Object.entries(rawModels).flatMap(([id, info]) => {
      if (!id || info?.isInternal || info?.disabled === true) return [];
      return expandAntigravityLiveModel(id, info?.displayName || info?.name || id);
    });
  }

  // If every live entry was internal/junk/retired, return empty so callers fall back
  // to the complete static registry (including Claude 5.5 and GPT-OSS).
  if (expanded.length === 0) return [];

  const parsed = [];
  const seen = new Set();
  for (const model of expanded) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    parsed.push(model);
  }

  if (Array.isArray(staticModels)) {
    for (const staticModel of staticModels) {
      if (
        staticModel?.id
        && /gemini-[34]/i.test(staticModel.id)
        && !isAntigravityHiddenModel(staticModel.id)
        && !seen.has(staticModel.id)
      ) {
        seen.add(staticModel.id);
        parsed.push({
          ...staticModel,
          id: staticModel.id,
          name: staticModel.name || staticModel.id,
        });
      }
    }
  }

  return parsed;
}

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}

