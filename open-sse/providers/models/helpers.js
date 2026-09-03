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

// Google Antigravity deployed flash version ceiling.
// Google Cloud Code backend currently deploys up to gemini-3.6-flash-(high|medium|low).
// Newer versions (3.7, 3.8, 3.9, 3.10, 4.0, etc.) are dynamically mapped down to the highest deployed tier.
export const DEFAULT_ANTIGRAVITY_MAX_DEPLOYED_FLASH_VERSION = "3.6";
let currentMaxDeployedFlashVersion = DEFAULT_ANTIGRAVITY_MAX_DEPLOYED_FLASH_VERSION;

function parseVersionParts(vStr) {
  const parts = String(vStr).split(".").map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0];
}

export function isAntigravityVersionNewer(vA, vB = currentMaxDeployedFlashVersion) {
  const [majA, minA] = parseVersionParts(vA);
  const [majB, minB] = parseVersionParts(vB);
  if (majA !== majB) return majA > majB;
  return minA > minB;
}

export function getAntigravityMaxDeployedFlashVersion() {
  return currentMaxDeployedFlashVersion;
}

export function setAntigravityMaxDeployedFlashVersion(version) {
  const vStr = String(version).trim();
  if (vStr && isAntigravityVersionNewer(vStr, currentMaxDeployedFlashVersion)) {
    currentMaxDeployedFlashVersion = vStr;
  }
}

export function resetAntigravityMaxDeployedFlashVersionForTests() {
  currentMaxDeployedFlashVersion = DEFAULT_ANTIGRAVITY_MAX_DEPLOYED_FLASH_VERSION;
}

/**
 * Resolves Antigravity upstream model names dynamically without hardcoding version numbers.
 * Any Gemini Flash variant (gemini-<ver>-flash-<tier> or gemini-<ver>-flash)
 * with version newer than the deployed Google Antigravity tier
 * is automatically mapped down to the highest available deployed tier:
 *   gemini-X.Y-flash-high   → gemini-<max>-flash-high
 *   gemini-X.Y-flash-medium → gemini-<max>-flash-medium
 *   gemini-X.Y-flash-low    → gemini-<max>-flash-low
 *   gemini-X.Y-flash        → gemini-<max>-flash-medium
 *
 * Models at or below the deployed tier (e.g. gemini-3.6-flash-high, gemini-3.5-flash-low)
 * remain untouched.
 */
// Supported Flash major version limits to guard against wild typos (gemini-999-flash-high).
export const ANTIGRAVITY_MAX_SUPPORTED_FLASH_MAJOR = 4;
export const ANTIGRAVITY_MAX_SUPPORTED_FLASH_MINOR = 20;

export function resolveAntigravityFlashModel(modelId) {
  if (typeof modelId !== "string" || !modelId) return modelId;
  const match = modelId.match(/^gemini-(\d+)(?:\.(\d+))?-flash(?:-(high|medium|low))?$/i);
  if (!match) return modelId;
  const maj = parseInt(match[1], 10);
  const min = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  // Guard against wild typos (gemini-999-flash-high): only resolve plausible versions (major 3 or 4, minor <= 20)
  if (maj < 3 || maj > ANTIGRAVITY_MAX_SUPPORTED_FLASH_MAJOR || min > ANTIGRAVITY_MAX_SUPPORTED_FLASH_MINOR) {
    return modelId;
  }
  const verStr = match[2] !== undefined ? `${maj}.${min}` : `${maj}.0`;
  const tier = (match[3] || "medium").toLowerCase();
  if (isAntigravityVersionNewer(verStr, currentMaxDeployedFlashVersion)) {
    return `gemini-${currentMaxDeployedFlashVersion}-flash-${tier}`;
  }
  return modelId;
}

