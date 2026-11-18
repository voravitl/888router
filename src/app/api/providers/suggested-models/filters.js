// Free OpenCode models that don't use the "-free" id suffix
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { parseOpenCodeGoCatalog } from "open-sse/services/opencodeGoModels.js";
import { normalizeUpstreamModel } from "open-sse/services/upstreamModelNormalizer.js";

const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

export const FILTERS = {
  "openrouter-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter(
        (m) =>
          m?.pricing?.prompt === "0" &&
          m?.pricing?.completion === "0" &&
          m?.context_length >= 200000
      )
      .map((m) => {
        const normalized = normalizeUpstreamModel("openrouter", m);
        const contextLength = normalized.contextWindow ?? m.context_length;
        return {
          id: normalized.id || m.id,
          name: normalized.name || m.name || m.id,
          contextLength,
          ...(normalized.maxOutput !== undefined ? { maxOutput: normalized.maxOutput } : {}),
          ...(normalized.vision !== undefined ? { vision: normalized.vision } : {}),
          ...(normalized.reasoning !== undefined ? { reasoning: normalized.reasoning } : {}),
          ...(normalized.tools !== undefined ? { tools: normalized.tools } : {}),
          ...(normalized.pdf !== undefined ? { pdf: normalized.pdf } : {}),
          ...(normalized.audioInput !== undefined ? { audioInput: normalized.audioInput } : {}),
          ...(normalized.videoInput !== undefined ? { videoInput: normalized.videoInput } : {}),
          ...(normalized.search !== undefined ? { search: normalized.search } : {}),
          ...(normalized.releasedAt !== undefined ? { releasedAt: normalized.releasedAt } : {}),
        };
      })
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0)),

  "opencode-free": (models) =>
    models
      .filter((m) => m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // OpenCode Go paid catalog: every id the live endpoint returns (no suffix
  // filter — Go catalog ids carry no -free suffix). Parsing shared with the
  // v1/models resolver via parseOpenCodeGoCatalog (single source — a schema
  // fix lands in both paths, never one). Static seed wins on collision
  // downstream (its supportedFormats stays authoritative for transport).
  "opencode-go": (models) => {
    if (!Array.isArray(models)) return [];
    try {
      return parseOpenCodeGoCatalog({ data: models });
    } catch {
      return [];
    }
  },

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // Generic OpenAI-compatible /v1/models: { data: [{ id, ... }] }
  // Used by bai, venice, gmi, vercel-ai-gateway, perplexity-agent, nousresearch, tokenrouter.
  // Signature: (models, providerHint) — providerHint is the dashboard's known
  // provider id (e.g. "bai", "venice") used to look up contextWindow fallback
  // from open-sse/providers/capabilities.js when the upstream response does
  // not include a context field (standard OpenAI /v1/models schema only
  // returns { id, object, created, owned_by }).
  "openai": (models, providerHint) =>
    (Array.isArray(models) ? models : [])
      .map((m) => {
        if (!m || typeof m !== "object") return null;
        const id = m.id;
        if (!id) return null;
        const normalized = normalizeUpstreamModel(providerHint || "openai", m);
        const ctxRaw = normalized.contextWindow ?? m.max_context_window ?? m.context_length ?? m.contextWindow ?? m.context_window ?? m.maxInputTokens;
        // Guard against non-numeric upstream values producing NaN (9-opus review).
        let ctx = (ctxRaw !== null && ctxRaw !== undefined && ctxRaw !== "" && Number.isFinite(Number(ctxRaw)) && Number(ctxRaw) > 0)
          ? Number(ctxRaw)
          : null;
        // Fall back to capabilities.js when upstream omits context — required
        // for OpenAI-compatible providers that do not extend the response
        // schema. The dashboard needs a non-NaN contextLength to render UI.
        if (ctx == null && typeof providerHint === "string" && providerHint.length > 0) {
          try {
            const caps = getCapabilitiesForModel(providerHint, id);
            if (caps?.contextWindow) ctx = caps.contextWindow;
          } catch {
            // capabilities lookup is best-effort; do not let it kill the row.
          }
        }
        const contextLength = normalized.contextWindow || ctx;
        return {
          id,
          name: normalized.name || normalized.display_name || id,
          ...(contextLength ? { contextLength } : {}),
          ...(normalized.vision !== undefined ? { vision: normalized.vision } : {}),
          ...(normalized.reasoning !== undefined ? { reasoning: normalized.reasoning } : {}),
          ...(normalized.tools !== undefined ? { tools: normalized.tools } : {}),
          ...(normalized.pdf !== undefined ? { pdf: normalized.pdf } : {}),
          ...(normalized.audioInput !== undefined ? { audioInput: normalized.audioInput } : {}),
          ...(normalized.videoInput !== undefined ? { videoInput: normalized.videoInput } : {}),
          ...(normalized.releasedAt !== undefined ? { releasedAt: normalized.releasedAt } : {}),
        };
      })
      .filter(Boolean),
};
