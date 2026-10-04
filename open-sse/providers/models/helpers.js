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

export function isMuseSparkModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  const clean = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  const base = clean.includes("/") ? clean.split("/").pop() : clean;
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base);
}

