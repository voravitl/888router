// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // Generic OpenAI-compatible /v1/models: { data: [{ id, ... }] }
  // Used by bai, venice, gmi, vercel-ai-gateway, perplexity-agent, nousresearch, tokenrouter.
  "openai": (models) =>
    (Array.isArray(models) ? models : [])
      .map((m) => {
        if (!m || typeof m !== "object") return null;
        const id = m.id;
        if (!id) return null;
        const ctxRaw = m.context_length || m.contextWindow || m.maxInputTokens;
        // Guard against non-numeric upstream values producing NaN (9-opus review).
        const ctx = Number.isFinite(Number(ctxRaw)) ? Number(ctxRaw) : null;
        return {
          id,
          name: m.name || m.display_name || id,
          ...(ctx ? { contextLength: ctx } : {}),
        };
      })
      .filter(Boolean),
};
