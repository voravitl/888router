"use client";

import { useState, useMemo, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, getProviderAlias } from "@/shared/constants/providers";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(id => FREE_PROVIDERS[id].noAuth);

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
}) {
  // Filter activeProviders by:
  // 1) Enabled connections only (p.isActive !== false)
  // 2) serviceKinds when kindFilter set (e.g. "webSearch", "webFetch")
  const filteredActiveProviders = useMemo(() => {
    const enabledOnly = (activeProviders || []).filter((p) => p.isActive !== false);
    if (!kindFilter) return enabledOnly;
    return enabledOnly.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [activeProviders, kindFilter]);
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [combos, setCombos] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [disabledModels, setDisabledModels] = useState({});
  const [syncedModels, setSyncedModels] = useState({});

  useEffect(() => {
    if (!isOpen) return;

    fetch("/api/combos")
      .then((res) => (res.ok ? res.json() : { combos: [] }))
      .then((data) => setCombos(data.combos || []))
      .catch(() => setCombos([]));

    fetch("/api/provider-nodes")
      .then((res) => (res.ok ? res.json() : { nodes: [] }))
      .then((data) => setProviderNodes(data.nodes || []))
      .catch(() => setProviderNodes([]));

    fetch("/api/models/custom")
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((data) => setCustomModels(data.models || []))
      .catch(() => setCustomModels([]));

    fetch("/api/models/disabled")
      .then((res) => (res.ok ? res.json() : { disabled: {} }))
      .then((data) => setDisabledModels(data.disabled || {}))
      .catch(() => setDisabledModels({}));

    fetch("/api/models/synced")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => setSyncedModels(data || {}))
      .catch(() => setSyncedModels({}));
  }, [isOpen]);

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  // Helper to extract synced models for a specific provider
  const getSyncedModelsForProvider = useCallback((providerId, targetAlias) => {
    const activeConns = (filteredActiveProviders || []).filter((p) => p.provider === providerId);
    const connIds = new Set(activeConns.map((c) => c.id));
    connIds.add(providerId);

    const found = [];
    const seenIds = new Set();

    for (const [key] of Object.entries(syncedModels || {})) {
      const colon = key.indexOf(":");
      if (colon <= 0) continue;
      const connId = key.slice(0, colon);
      const modelId = key.slice(colon + 1);
      if (connIds.has(connId) && !seenIds.has(modelId)) {
        seenIds.add(modelId);
        found.push({
          id: modelId,
          name: modelId,
          value: `${targetAlias}/${modelId}`,
          isCustom: true,
        });
      }
    }
    return found;
  }, [filteredActiveProviders, syncedModels]);

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map directly to model.type field
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models) => {
      if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map(p => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set([
      ...activeConnectionIds,  // Only connected providers
      ...noAuthIds,            // No-auth providers (kind-filtered)
    ]);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name,
          alias,
          color: providerInfo.color,
          models: [{ id: providerId, name: providerInfo.name, value: providerId }],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const aliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`) || fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => {
            const rawId = fullModel.startsWith(`${alias}/`) ? fullModel.slice(alias.length + 1) : fullModel.slice(providerId.length + 1);
            return {
              id: rawId,
              name: aliasName,
              value: `${alias}/${rawId}`,
            };
          });
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias || m.providerAlias === providerId)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));
        const syncedRegisteredModels = getSyncedModelsForProvider(providerId, alias);

        let combined = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          const registeredTyped = customRegisteredModels.filter((m) => getModelKind(m) === kindFilter);
          combined = [
            ...registeredTyped,
            ...getModelsByProviderId(providerId)
              .filter((m) => getModelKind(m) === kindFilter)
              .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
              .filter((m) => !registeredTyped.some((registered) => registered.value === m.value)),
          ];
          if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
            if (supports) combined = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        } else {
          const registeredLlms = customRegisteredModels.filter((m) => !getModelKind(m) || getModelKind(m) === "llm");
          const hardcoded = getModelsByProviderId(providerId)
            .filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }));

          const merged = [...registeredLlms, ...syncedRegisteredModels, ...aliasModels, ...hardcoded];
          const seen = new Set();
          combined = merged.filter((m) => {
            if (seen.has(m.value)) return false;
            seen.add(m.value);
            return true;
          });
        }

        if (combined.length > 0) {
          const matchedNode = providerNodes.find(node => node.id === providerId);
          const displayName = matchedNode?.name || providerInfo.name;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        const connection = activeProviders.find(p => p.provider === providerId);
        const matchedNode = providerNodes.find(node => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name;
        const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;

        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`) || fullModel.startsWith(`${nodePrefix}/`))
          .map(([aliasName, fullModel]) => {
            const rawId = fullModel.startsWith(`${providerId}/`) ? fullModel.slice(providerId.length + 1) : fullModel.slice(nodePrefix.length + 1);
            return {
              id: rawId,
              name: aliasName,
              value: `${nodePrefix}/${rawId}`,
            };
          });

        const registeredCustom = customModels
          .filter((m) => m.providerAlias === providerId || m.providerAlias === nodePrefix)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            isCustom: true,
          }));

        const syncedModelsList = getSyncedModelsForProvider(providerId, nodePrefix);

        const seen = new Set();
        const mergedModels = [...nodeModels, ...registeredCustom, ...syncedModelsList].filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        });

        const modelsToShow = mergedModels.length > 0 ? mergedModels : [{
          id: `__placeholder__${providerId}`,
          name: `${nodePrefix}/model-id`,
          value: `${nodePrefix}/model-id`,
          isPlaceholder: true,
        }];

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: mergedModels.length > 0,
        };
      } else {
        const hardcodedModels = getModelsByProviderId(providerId);

        // Aliases targeting this provider
        const customAliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) =>
            fullModel.startsWith(`${alias}/`) || fullModel.startsWith(`${providerId}/`)
          )
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.startsWith(`${alias}/`) ? fullModel.slice(alias.length + 1) : fullModel.slice(providerId.length + 1);
            return { id: modelId, name: aliasName, value: `${alias}/${modelId}`, isCustom: true };
          });

        // Custom models registered via /api/models/custom
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias || m.providerAlias === providerId)
          .map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        // Synced models from /api/models/synced
        const syncedRegisteredModels = getSyncedModelsForProvider(providerId, alias);

        const merged = [
          ...hardcodedModels.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) })),
          ...customRegisteredModels,
          ...syncedRegisteredModels,
          ...customAliasModels,
        ];

        // Dedupe by value
        const seen = new Set();
        let allModels = filterByKind(merged.filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
          if (supports) {
            allModels = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    Object.entries(groups).forEach(([providerId, group]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set([
        ...(disabledModels[aliasKey] || []),
        ...(disabledModels[providerId] || []),
      ]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m) => !disabledIds.has(m.id) && !disabledIds.has(m.value));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [filteredActiveProviders, modelAliases, allProviders, providerNodes, customModels, disabledModels, kindFilter, activeProviders, getSyncedModelsForProvider]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter(c => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter]);

  // Filter models by search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    // Sort models alphabetically, with added models floated to top
    const sortModels = (models) => {
      const added = models.filter((m) => addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      const rest = models.filter((m) => !addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      return [...added, ...rest];
    };

    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      if (query) {
        const providerNameMatches = group.name.toLowerCase().includes(query);
        models = models.filter(
          (m) =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        if (models.length === 0 && !providerNameMatches) return;
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, searchQuery, addedModelValues]);

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchQuery("");
      }}
      title={title}
      size="md"
      className="p-4!"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>info</span>
        <span>Click to add, click again to remove. Changes are saved automatically.</span>
      </div>

      {/* Search - compact */}
      <div className="mb-3">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
            search
          </span>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      {/* Models grouped by provider - compact */}
      <div className="max-h-[400px] overflow-y-auto space-y-3">
        {/* Manual custom model add from search query */}
        {searchQuery.trim() && (
          <div className="pb-2 border-b border-border/50">
            <button
              onClick={() => handleSelect({ id: searchQuery.trim(), name: searchQuery.trim(), value: searchQuery.trim(), isCustom: true })}
              className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border border-dashed border-primary/40 text-primary bg-primary/5 hover:bg-primary/10 transition-colors flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 truncate">
                <span className="material-symbols-outlined text-[14px]">add_circle</span>
                <span className="truncate">Add custom model: <strong className="font-mono">{searchQuery.trim()}</strong></span>
              </span>
              <span className="text-[10px] text-text-muted shrink-0">Click to use</span>
            </button>
          </div>
        )}

        {/* Combos section - always first */}
        {filteredCombos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
              <span className="text-xs font-medium text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo) => {
                const isSelected = selectedModel === combo.name;
                return (
                  <button
                    key={combo.id}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1
                      ${isSelected
                        ? "bg-primary text-white border-primary"
                        : addedModelValues.includes(combo.name)
                          ? "bg-primary border-primary text-white hover:bg-primary-hover"
                          : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {addedModelValues.includes(combo.name) && (
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                    )}
                    {combo.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Provider models */}
        {Object.entries(filteredGroups).map(([providerId, group]) => (
          <div key={providerId}>
            {/* Provider header */}
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <ProviderIcon
                src={`/providers/${providerId}.png`}
                alt={group.name}
                size={14}
                fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                fallbackColor={group.color}
              />
              <span className="text-xs font-medium text-primary">
                {group.name}
              </span>
              <span className="text-[10px] text-text-muted">
                ({group.models.length})
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {group.models.map((model) => {
                const isSelected = selectedModel === model.value;
                const isPlaceholder = model.isPlaceholder;
                return (
                  <button
                    key={model.value}
                    onClick={() => handleSelect(model)}
                    title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer
                      ${isPlaceholder
                        ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                        : isSelected
                          ? "bg-primary text-white border-primary"
                          : addedModelValues.includes(model.value)
                            ? "bg-primary border-primary text-white hover:bg-primary-hover"
                            : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    <span className="flex items-center gap-1">
                      {addedModelValues.includes(model.value) && !isPlaceholder && (
                        <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                      )}
                      {isPlaceholder ? (
                        <>
                          <span className="material-symbols-outlined text-[11px]">edit</span>
                          {model.name}
                        </>
                      ) : model.isCustom ? (
                        <>
                          {model.name}
                          <span className="text-[9px] opacity-60 font-normal">custom</span>
                          <CapacityBadges caps={getCaps(model.value)} />
                        </>
                      ) : (
                        <>
                          {model.name}
                          <CapacityBadges caps={getCaps(model.value)} />
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
          <div className="text-center py-4 text-text-muted">
            <span className="material-symbols-outlined text-2xl mb-1 block">
              search_off
            </span>
            <p className="text-xs">No models found</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    })
  ),
  title: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
};
