import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, resolveProviderId, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getAllModelDynamicCapabilities, getSyncedModelsMap } from "@/lib/db";

// Capability fields exposed to the dashboard for dynamically synced models.
const DYNAMIC_CAP_FIELDS = [
  "vision", "pdf", "audioInput", "videoInput", "tools", "reasoning",
  "search", "contextWindow", "maxOutput",
];

// A synced row is keyed by provider id; clients address models by any of the
// provider's aliases (opencode-go → ocg, opencode → oc/zen/...). Index every
// spelling so the dashboard can look up caps with the id it already holds.
function providerKeyVariants(providerId) {
  const variants = new Set([providerId]);
  const alias = getProviderAlias(providerId);
  if (alias) variants.add(alias);
  for (const [candidate, id] of Object.entries(ALIAS_TO_ID)) {
    if (id === providerId) variants.add(candidate);
  }
  return [...variants];
}

// GET /api/models - Get models with aliases
export async function GET() {
  try {
    const modelAliases = await getModelAliases();
    const disabled = await getDisabledModels();

    // Synced metadata is optional enrichment: a missing/unavailable DB must
    // never take the dashboard model list down.
    let dynamicCapsRows = new Map();
    let syncedMap = {};
    try {
      dynamicCapsRows = (await getAllModelDynamicCapabilities()) || new Map();
    } catch (error) {
      console.log("Could not load synced model capabilities:", error?.message);
    }
    try {
      syncedMap = (await getSyncedModelsMap()) || {};
    } catch (error) {
      console.log("Could not load synced models map:", error?.message);
    }

    const staleModelIds = new Set();
    for (const [key, entry] of Object.entries(syncedMap)) {
      if (entry?.status !== "stale") continue;
      const colon = key.indexOf(":");
      if (colon >= 0) staleModelIds.add(key.slice(colon + 1));
    }

    const dynamicCapsByKey = {};
    const dynamicModels = [];
    for (const [scopedKey, caps] of (dynamicCapsRows instanceof Map ? dynamicCapsRows.entries() : Object.entries(dynamicCapsRows))) {
      if (!caps || typeof caps !== "object") continue;
      const colon = typeof scopedKey === "string" ? scopedKey.indexOf(":") : -1;
      if (colon <= 0) continue;
      const providerId = scopedKey.slice(0, colon);
      const modelId = scopedKey.slice(colon + 1);
      if (!providerId || !modelId) continue;

      const picked = {};
      for (const field of DYNAMIC_CAP_FIELDS) {
        if (caps[field] !== undefined) picked[field] = caps[field];
      }
      for (const variant of providerKeyVariants(providerId)) {
        dynamicCapsByKey[`${variant}/${modelId}`] = picked;
      }

      // Stale ghosts keep their capabilities available for lookup but are not
      // injected as live selectable models (no auto-breaking of combos/aliases).
      if (staleModelIds.has(modelId)) continue;
      dynamicModels.push({
        provider: providerId,
        model: modelId,
        fullModel: `${providerId}/${modelId}`,
        alias: modelAliases[`${providerId}/${modelId}`] || modelId,
        caps: picked,
        status: "active",
        source: "synced",
        dynamic: true,
      });
    }

    const models = AI_MODELS
      .filter((m) => {
        const alias = getProviderAlias(m.provider) || m.provider;
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerId = resolveProviderId(m.provider) || m.provider;
        const c = getCapabilitiesForModel(providerId, m.model);
        return {
          ...m,
          fullModel,
          alias: modelAliases[fullModel] || m.model,
          caps: { vision: c.vision, search: c.search, reasoning: c.reasoning, contextWindow: c.contextWindow },
        };
      });

    // Dedupe dynamic models against the static catalogue: a newly-synced id
    // that is already registered keeps its curated metadata.
    const known = new Set(models.map((m) => (typeof m.fullModel === "string" ? m.fullModel : `${m.provider}/${m.model}`)));
    for (const model of dynamicModels) {
      if (known.has(model.fullModel)) continue;
      known.add(model.fullModel);
      models.push(model);
    }

    return NextResponse.json({ models, dynamicCapsByKey });
  } catch (error) {
    console.error("Error fetching models:", error);
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}

// PUT /api/models - Update model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    const modelAliases = await getModelAliases();

    // Check if alias already exists for different model
    const existingModel = Object.entries(modelAliases).find(
      ([key, val]) => val === alias && key !== model
    );

    if (existingModel) {
      return NextResponse.json({ error: "Alias already in use" }, { status: 400 });
    }

    // Update alias
    await setModelAlias(model, alias);

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.error("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}
