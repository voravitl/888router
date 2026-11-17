import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { AI_PROVIDERS, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getModelKind } from "@/shared/constants/models";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getComboByName } from "@/lib/localDb";
import { resolveVirtualAutoCombo } from "open-sse/services/autoCombo/virtualFactory.js";
import { applyComboContextFields } from "../route.js";
import {
  getAllModelDynamicCapabilities,
  getModelDynamicCapabilities,
  getSyncedModelsMap,
} from "@/lib/db";

const SYNCED_CAP_FIELDS = [
  "contextWindow", "maxOutput", "vision", "pdf", "audioInput",
  "videoInput", "tools", "reasoning", "search", "releasedAt",
];

/**
 * Look up capabilities persisted by a prior model sync for a model that is not
 * in the static PROVIDER_MODELS catalogue. Every read fails open — a missing
 * DB must degrade to a 404 (the old behaviour), never a 500.
 */
async function lookupSyncedCapabilities(providerId, modelId) {
  let raw = null;
  try {
    raw = await getModelDynamicCapabilities(providerId, modelId);
  } catch {}
  if (!raw || typeof raw !== "object") {
    try {
      const all = await getAllModelDynamicCapabilities();
      if (all instanceof Map) {
        const baseId = modelId.split("/").pop();
        raw = all.get(`${providerId}:${baseId}`) || all.get(`${providerId}:${modelId}`) || null;
        if (!raw) {
          for (const [key, value] of all.entries()) {
            if (typeof key !== "string") continue;
            const colon = key.indexOf(":");
            if (colon <= 0 || key.slice(colon + 1) !== baseId) continue;
            const keyProvider = key.slice(0, colon);
            if ((ALIAS_TO_ID[keyProvider] || keyProvider) === providerId) {
              raw = value;
              break;
            }
          }
        }
      }
    } catch {}
  }
  if (!raw || typeof raw !== "object") return null;

  const caps = {};
  for (const field of SYNCED_CAP_FIELDS) {
    if (raw[field] !== undefined) caps[field] = raw[field];
  }
  if (Object.keys(caps).length === 0) return null;

  let status = "active";
  let lastSyncedAt = null;
  try {
    const synced = await getSyncedModelsMap();
    for (const [key, entry] of Object.entries(synced || {})) {
      const colon = key.indexOf(":");
      if (colon >= 0 && key.slice(colon + 1) === modelId) {
        status = entry?.status || "active";
        lastSyncedAt = entry?.lastSyncedAt ?? null;
        break;
      }
    }
  } catch {}

  return { caps, status, lastSyncedAt };
}

const KIND_ENDPOINT = {
  llm: "/v1/chat/completions",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
  stt: "/v1/audio/transcriptions",
  embedding: "/v1/embeddings",
  imageToText: "/v1/chat/completions",
  webSearch: "/v1/search",
  webFetch: "/v1/fetch",
};

const TTS_VOICES_API = new Set(["elevenlabs", "edge-tts", "deepgram", "inworld", "local-device"]);

function buildInfo({ alias, providerId, model, kind, providerInfo, syncedCaps }) {
  const out = {
    id: `${alias}/${model.id}`,
    name: model.name || model.id,
    kind,
    owned_by: alias,
    endpoint: KIND_ENDPOINT[kind] || null,
  };
  if (model.params) out.params = model.params;
  if (model.capabilities || syncedCaps) {
    out.capabilities = { ...(model.capabilities || {}), ...(syncedCaps || {}) };
  }
  if (model.options) out.options = model.options;
  if (model.dimensions) out.dimensions = model.dimensions;
  const caps = getCapabilitiesForModel(providerId, model.id);
  const resolvedContextWindow = model.contextWindow || syncedCaps?.contextWindow || caps?.contextWindow;
  const resolvedMaxOutput = syncedCaps?.maxOutput || caps?.maxOutput;
  if (resolvedContextWindow) {
    out.context_length = resolvedContextWindow;
    out.contextWindow = resolvedContextWindow;
    out.context_window = resolvedContextWindow;
    out.max_tokens = resolvedMaxOutput || 128000;
    out.max_completion_tokens = resolvedMaxOutput || 128000;
  } else if (resolvedMaxOutput) {
    out.max_tokens = resolvedMaxOutput;
    out.max_completion_tokens = resolvedMaxOutput;
  }
  if (kind === "tts" && TTS_VOICES_API.has(providerId)) {
    out.voicesUrl = `/v1/audio/voices?provider=${providerId}`;
  }
  if (kind === "webSearch" && providerInfo?.searchConfig) {
    const cfg = providerInfo.searchConfig;
    if (cfg.searchTypes) out.searchTypes = cfg.searchTypes;
    if (cfg.maxMaxResults) out.maxResults = cfg.maxMaxResults;
    if (cfg.requiredOptions) out.required = cfg.requiredOptions;
  }
  return out;
}

// id format: "{alias}/{modelId}" - alias may also be providerId or combo name
async function lookup(fullId, requestedKind) {
  if (!fullId) return null;

  if (fullId.startsWith("auto/")) {
    try {
      const virtual = resolveVirtualAutoCombo(fullId);
      if (virtual) {
        const memberIds = (virtual?.models || []).map((m) => (typeof m === "string" ? m : m?.id || "")).filter(Boolean);
        if (!memberIds.length) return null;
        const out = {
          id: fullId,
          name: fullId,
          kind: "llm",
          owned_by: "auto-combo",
          isCombo: true,
          endpoint: KIND_ENDPOINT["llm"] || "/v1/chat/completions",
          comboMembers: memberIds.slice(0, 8),
          comboMemberCount: memberIds.length,
        };
        applyComboContextFields(out, { models: memberIds });
        return out;
      }
    } catch (e) {
      console.warn(`[models/info] virtual auto-combo lookup failed for id=${fullId}:`, e?.message || e);
    }
  }

  if (!fullId.includes("/")) {
    try {
      const combo = await getComboByName(fullId);
      if (combo) {
        const kind = combo.kind || "llm";
        const memberIds = Array.isArray(combo?.models)
          ? combo.models.map((m) => (typeof m === "string" ? m : m?.id || "")).filter(Boolean)
          : [];
        const out = {
          id: combo.name,
          name: combo.name,
          kind,
          owned_by: "combo",
          isCombo: true,
          endpoint: KIND_ENDPOINT[kind] || "/v1/chat/completions",
          ...(memberIds.length > 0 ? {
            comboMembers: memberIds.slice(0, 8),
            comboMemberCount: memberIds.length,
          } : {}),
        };
        // webSearch/webFetch: no chat context; LLM: only catalog-resolved fields
        applyComboContextFields(out, combo);
        return out;
      }
    } catch (e) {
      console.warn(`[models/info] combo lookup failed for id=${fullId}:`, e?.message || e);
    }
    return null;
  }

  const slash = fullId.indexOf("/");
  const alias = fullId.slice(0, slash);
  const modelId = fullId.slice(slash + 1);
  const providerId = ALIAS_TO_ID[alias] || alias;
  const providerInfo = AI_PROVIDERS[providerId];

  // PROVIDER_MODELS lookup (by alias key, fallback to providerId)
  const list = PROVIDER_MODELS[alias] || PROVIDER_MODELS[providerId] || [];
  const m = requestedKind
    ? list.find((x) => x.id === modelId && getModelKind(x, "llm") === requestedKind)
    : list.find((x) => x.id === modelId);
  if (m) {
    const kind = getModelKind(m, "llm");
    return buildInfo({ alias, providerId, model: m, kind, providerInfo });
  }

  // Dynamically synced model absent from the static catalogue. Ghost/stale
  // rows still resolve (with their lifecycle status) so combos and aliases
  // that reference a retired upstream id do not break.
  const synced = await lookupSyncedCapabilities(providerId, modelId);
  if (synced) {
    const out = buildInfo({
      alias,
      providerId,
      model: {
        id: modelId,
        name: modelId,
        contextWindow: synced.caps.contextWindow,
        capabilities: synced.caps,
      },
      kind: "llm",
      providerInfo,
      syncedCaps: synced.caps,
    });
    // Surface the canonical fields at top level as well as under
    // `capabilities` — clients read both shapes.
    for (const field of SYNCED_CAP_FIELDS) {
      if (synced.caps[field] !== undefined) out[field] = synced.caps[field];
    }
    out.status = synced.status;
    out.lastSyncedAt = synced.lastSyncedAt;
    out.source = "synced";
    return out;
  }

  // Web search/fetch — virtual model id "search" / "fetch"
  if (modelId === "search" && providerInfo?.searchConfig) {
    return buildInfo({
      alias, providerId, kind: "webSearch", providerInfo,
      model: { id: "search", name: `${providerInfo.name} Search`, params: ["query", "max_results", "country", "language", "time_range", "domain_filter", "search_type"] },
    });
  }
  if (modelId === "fetch" && providerInfo?.fetchConfig) {
    return buildInfo({
      alias, providerId, kind: "webFetch", providerInfo,
      model: { id: "fetch", name: `${providerInfo.name} Fetch`, params: ["url", "format", "max_characters"] },
    });
  }
  return null;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/models/info?id={alias}/{modelId} — metadata for a single model
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const kind = searchParams.get("kind");
  if (!id) {
    return Response.json(
      { error: { message: "Missing required query param: id (e.g. ?id=openai/dall-e-3)", type: "invalid_request_error" } },
      { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  const info = await lookup(id, kind);
  if (!info) {
    return Response.json(
      { error: { message: `Model not found: ${id}`, type: "not_found" } },
      { status: 404, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
  return Response.json(info, { headers: { "Access-Control-Allow-Origin": "*" } });
}
