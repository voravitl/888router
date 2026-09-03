"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { formatContextWindow, CONTEXT_FILTER_OPTIONS } from "@/shared/utils/contextWindow";
import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  AI_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  getProviderAlias,
} from "@/shared/constants/providers";

export { formatContextWindow, CONTEXT_FILTER_OPTIONS };

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter((id) => FREE_PROVIDERS[id].noAuth);

// Module-level cache with 60s TTL so re-opening the picker doesn't re-download 5,000+ synced models
let modalDataCache = null;
let modalDataInflight = null;
let cacheGeneration = 0;

export function invalidateModalDataCache() {
  modalDataCache = null;
  modalDataInflight = null;
  cacheGeneration++;
}

// Module-level event listener: invalidates cache even when modal is unmounted / closed
if (typeof window !== "undefined") {
  window.addEventListener("customModelChanged", invalidateModalDataCache);
}

async function loadModalData() {
  if (modalDataCache && Date.now() - modalDataCache.timestamp < 60000) {
    return modalDataCache.data;
  }
  if (modalDataInflight) return modalDataInflight;

  const currentGen = cacheGeneration;

  modalDataInflight = (async () => {
    try {
      const [combosRes, nodesRes, customRes, disabledRes, syncedRes] = await Promise.all([
        fetch("/api/combos").catch(() => ({ ok: false })),
        fetch("/api/provider-nodes").catch(() => ({ ok: false })),
        fetch("/api/models/custom").catch(() => ({ ok: false })),
        fetch("/api/models/disabled").catch(() => ({ ok: false })),
        fetch("/api/models/synced").catch(() => ({ ok: false })),
      ]);

      // If any critical endpoint failed, don't write corrupt/empty data to cache
      if (!syncedRes.ok || !customRes.ok || !disabledRes.ok) {
        return null;
      }

      const combos = combosRes.ok ? (await combosRes.json().catch(() => ({}))).combos || [] : [];
      const nodes = nodesRes.ok ? (await nodesRes.json().catch(() => ({}))).nodes || [] : [];
      const custom = customRes.ok ? (await customRes.json().catch(() => ({}))).models || [] : [];
      const disabled = disabledRes.ok ? (await disabledRes.json().catch(() => ({}))).disabled || {} : {};
      const synced = syncedRes.ok ? await syncedRes.json().catch(() => ({})) : {};

      const data = { combos, nodes, custom, disabled, synced };
      // Check generation: if invalidated while in-flight, do not write stale result
      if (currentGen === cacheGeneration) {
        modalDataCache = { timestamp: Date.now(), data };
      }
      return data;
    } finally {
      if (currentGen === cacheGeneration) {
        modalDataInflight = null;
      }
    }
  })();

  return modalDataInflight;
}

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
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [contextFilter, setContextFilter] = useState(0);
  const [filterVision, setFilterVision] = useState(false);
  const [filterReasoning, setFilterReasoning] = useState(false);

  const [combos, setCombos] = useState(() => modalDataCache?.data?.combos || []);
  const [providerNodes, setProviderNodes] = useState(() => modalDataCache?.data?.nodes || []);
  const [customModels, setCustomModels] = useState(() => modalDataCache?.data?.custom || []);
  const [disabledModels, setDisabledModels] = useState(() => modalDataCache?.data?.disabled || {});
  const [syncedModels, setSyncedModels] = useState(() => modalDataCache?.data?.synced || {});

  const loadData = useCallback(() => {
    loadModalData().then((data) => {
      if (!data) return;
      setCombos(data.combos);
      setProviderNodes(data.nodes);
      setCustomModels(data.custom);
      setDisabledModels(data.disabled);
      setSyncedModels(data.synced);
    });
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, loadData]);

  // Invalidate cache and reload on customModelChanged
  useEffect(() => {
    const handleInvalidate = () => {
      invalidateModalDataCache();
      if (isOpen) {
        loadData();
      }
    };
    window.addEventListener("customModelChanged", handleInvalidate);
    return () => {
      window.removeEventListener("customModelChanged", handleInvalidate);
    };
  }, [isOpen, loadData]);

  // Set lookup for addedModelValues for O(1) membership checks in sorting and rendering
  const addedSet = useMemo(() => new Set(addedModelValues || []), [addedModelValues]);

  // Filter activeProviders by enabled connections and kindFilter
  const filteredActiveProviders = useMemo(() => {
    const enabledOnly = (activeProviders || []).filter((p) => p.isActive !== false);
    if (!kindFilter) return enabledOnly;
    return enabledOnly.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [activeProviders, kindFilter]);

  const allProviders = useMemo(
    () => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }),
    []
  );

  // Pre-index syncedModels by connId to turn O(Providers * SyncedModels) loop into O(1) Map lookup
  const syncedModelsByConn = useMemo(() => {
    const map = new Map();
    for (const key of Object.keys(syncedModels || {})) {
      const colon = key.indexOf(":");
      if (colon <= 0) continue;
      const connId = key.slice(0, colon);
      const modelId = key.slice(colon + 1);
      let list = map.get(connId);
      if (!list) {
        list = [];
        map.set(connId, list);
      }
      list.push(modelId);
    }
    return map;
  }, [syncedModels]);

  // Helper to extract synced models for a specific provider
  const getSyncedModelsForProvider = useCallback(
    (providerId, targetAlias) => {
      const activeConns = (filteredActiveProviders || []).filter((p) => p.provider === providerId);
      const connIds = new Set(activeConns.map((c) => c.id));
      connIds.add(providerId);

      const found = [];
      const seenIds = new Set();

      for (const connId of connIds) {
        const modelIds = syncedModelsByConn.get(connId);
        if (!modelIds) continue;
        for (const modelId of modelIds) {
          if (!seenIds.has(modelId)) {
            seenIds.add(modelId);
            found.push({
              id: modelId,
              name: modelId,
              value: `${targetAlias}/${modelId}`,
              isCustom: true,
            });
          }
        }
      }
      return found;
    },
    [filteredActiveProviders, syncedModelsByConn]
  );

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    const filterByKind = (models) => {
      if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    const activeConnectionIds = filteredActiveProviders.map((p) => p.provider);
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;

    const providerIdsToShow = new Set([...activeConnectionIds, ...noAuthIds]);

    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

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
            return { id: rawId, name: aliasName, value: `${alias}/${rawId}` };
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
          const matchedNode = providerNodes.find((node) => node.id === providerId);
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
        const connection = activeProviders.find((p) => p.provider === providerId);
        const matchedNode = providerNodes.find((node) => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name;
        const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;

        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`) || fullModel.startsWith(`${nodePrefix}/`))
          .map(([aliasName, fullModel]) => {
            const rawId = fullModel.startsWith(`${providerId}/`) ? fullModel.slice(providerId.length + 1) : fullModel.slice(nodePrefix.length + 1);
            return { id: rawId, name: aliasName, value: `${nodePrefix}/${rawId}` };
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

        const modelsToShow =
          mergedModels.length > 0
            ? mergedModels
            : [
                {
                  id: `__placeholder__${providerId}`,
                  name: `${nodePrefix}/model-id`,
                  value: `${nodePrefix}/model-id`,
                  isPlaceholder: true,
                },
              ];

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

        const customAliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`) || fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.startsWith(`${alias}/`) ? fullModel.slice(alias.length + 1) : fullModel.slice(providerId.length + 1);
            return { id: modelId, name: aliasName, value: `${alias}/${modelId}`, isCustom: true };
          });

        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias || m.providerAlias === providerId)
          .map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        const syncedRegisteredModels = getSyncedModelsForProvider(providerId, alias);

        const merged = [
          ...hardcodedModels.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) })),
          ...customRegisteredModels,
          ...syncedRegisteredModels,
          ...customAliasModels,
        ];

        const seen = new Set();
        let allModels = filterByKind(
          merged.filter((m) => {
            if (seen.has(m.value)) return false;
            seen.add(m.value);
            return true;
          })
        );

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

    // Filter out disabled models per provider
    Object.entries(groups).forEach(([providerId, group]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set([...(disabledModels[aliasKey] || []), ...(disabledModels[providerId] || [])]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m) => !disabledIds.has(m.id) && !disabledIds.has(m.value));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [
    filteredActiveProviders,
    modelAliases,
    allProviders,
    providerNodes,
    customModels,
    disabledModels,
    kindFilter,
    activeProviders,
    getSyncedModelsForProvider,
  ]);

  // Provider Filter List with counts for quick-filter tabs
  const providerFilterList = useMemo(() => {
    return Object.entries(groupedModels).map(([providerId, group]) => ({
      id: providerId,
      name: group.name,
      color: group.color,
      count: group.models.length,
    }));
  }, [groupedModels]);

  // Total models across all connected providers
  const totalAvailableModels = useMemo(() => {
    return Object.values(groupedModels).reduce((acc, g) => acc + (g.models?.length || 0), 0);
  }, [groupedModels]);

  // Filter combos by search query, provider selection, and capabilities
  const filteredCombos = useMemo(() => {
    if (kindFilter) return [];
    if (selectedProvider !== "all" && selectedProvider !== "combos") return [];
    let list = combos;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    if (contextFilter > 0 || filterVision || filterReasoning) {
      list = list.filter((c) => {
        const members = c.models || [];
        if (members.length === 0) return false;
        return members.some((m) => {
          const caps = getCaps(m) || {};
          if (contextFilter > 0 && (caps.contextWindow || 0) < contextFilter) return false;
          if (filterVision && !caps.vision) return false;
          if (filterReasoning && !caps.reasoning) return false;
          return true;
        });
      });
    }
    return list;
  }, [combos, searchQuery, kindFilter, selectedProvider, contextFilter, filterVision, filterReasoning, getCaps]);

  // Filter models by provider, contextWindow, capabilities, and search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    // Sort models with O(1) Set membership: added models floated to top, then alphabetically
    const sortModels = (models) => {
      const added = models.filter((m) => addedSet.has(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      const rest = models.filter((m) => !addedSet.has(m.value)).sort((a, b) => a.name.localeCompare(b.name));
      return [...added, ...rest];
    };

    const filtered = {};

    Object.entries(groupedModels).forEach(([providerId, group]) => {
      // Filter by selected provider tab
      if (selectedProvider !== "all" && selectedProvider !== providerId) return;

      let models = group.models;

      // Filter by Context Window and Capabilities
      if (contextFilter > 0 || filterVision || filterReasoning) {
        models = models.filter((m) => {
          if (m.isPlaceholder) return false;
          const caps = getCaps(m.value) || {};
          if (contextFilter > 0) {
            const cw = caps.contextWindow;
            // Genuine unknown models have undefined cw and must not pass context filters
            if (!cw || cw < contextFilter) return false;
          }
          if (filterVision && !caps.vision) return false;
          if (filterReasoning && !caps.reasoning) return false;
          return true;
        });
      }

      // Filter by search query (match provider name or model name/id/value)
      if (query) {
        const providerNameMatches =
          group.name.toLowerCase().includes(query) || providerId.toLowerCase().includes(query);

        if (!providerNameMatches) {
          models = models.filter(
            (m) =>
              m.name.toLowerCase().includes(query) ||
              m.id.toLowerCase().includes(query) ||
              m.value.toLowerCase().includes(query)
          );
          if (models.length === 0) return;
        }
      }

      if (models.length > 0) {
        filtered[providerId] = {
          ...group,
          models: sortModels(models),
        };
      }
    });

    return filtered;
  }, [
    groupedModels,
    selectedProvider,
    contextFilter,
    filterVision,
    filterReasoning,
    searchQuery,
    addedSet,
    getCaps,
  ]);

  const displayedModelsCount = useMemo(() => {
    return Object.values(filteredGroups).reduce((acc, g) => acc + (g.models?.length || 0), 0);
  }, [filteredGroups]);

  const hasActiveFilters =
    searchQuery.trim() !== "" ||
    selectedProvider !== "all" ||
    contextFilter !== 0 ||
    filterVision ||
    filterReasoning;

  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedProvider("all");
    setContextFilter(0);
    setFilterVision(false);
    setFilterReasoning(false);
  };

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedSet.has(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      handleResetFilters();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        handleResetFilters();
      }}
      title={title}
      size="lg"
      className="p-4! sm:p-5!"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>
          info
        </span>
        <span>Click to add, click again to remove. Changes are saved automatically.</span>
      </div>

      {/* Search Bar with Clear Button */}
      <div className="mb-2.5">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
            search
          </span>
          <input
            type="text"
            aria-label="Search models and providers"
            placeholder="Search models, providers (e.g. minimax, flash, 1m, sonnet)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 bg-surface border border-border rounded-lg text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-text-muted/60"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5 rounded cursor-pointer transition-colors focus-visible:ring-1 focus-visible:ring-primary"
              title="Clear search"
              aria-label="Clear search"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Provider Quick-Filter Bar */}
      <div className="mb-2.5">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
          <button
            onClick={() => setSelectedProvider("all")}
            aria-pressed={selectedProvider === "all"}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition-all border flex items-center gap-1.5 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
              selectedProvider === "all"
                ? "bg-primary text-white border-primary shadow-xs font-semibold"
                : "bg-surface border-border/80 text-text-muted hover:border-primary/40 hover:text-text-main"
            }`}
          >
            <span>All Providers</span>
            <span
              className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                selectedProvider === "all" ? "bg-white/20 text-white" : "bg-black/5 dark:bg-white/10 text-text-muted"
              }`}
            >
              {totalAvailableModels}
            </span>
          </button>

          {filteredCombos.length > 0 && !kindFilter && (
            <button
              onClick={() => setSelectedProvider(selectedProvider === "combos" ? "all" : "combos")}
              aria-pressed={selectedProvider === "combos"}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition-all border flex items-center gap-1.5 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
                selectedProvider === "combos"
                  ? "bg-primary text-white border-primary shadow-xs font-semibold"
                  : "bg-surface border-border/80 text-text-muted hover:border-primary/40 hover:text-text-main"
              }`}
            >
              <span className="material-symbols-outlined text-[14px]">layers</span>
              <span>Combos</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  selectedProvider === "combos" ? "bg-white/20 text-white" : "bg-black/5 dark:bg-white/10 text-text-muted"
                }`}
              >
                {filteredCombos.length}
              </span>
            </button>
          )}

          {providerFilterList.map(({ id, name, color, count }) => (
            <button
              key={id}
              onClick={() => setSelectedProvider(selectedProvider === id ? "all" : id)}
              aria-pressed={selectedProvider === id}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition-all border flex items-center gap-1.5 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
                selectedProvider === id
                  ? "bg-primary text-white border-primary shadow-xs font-semibold"
                  : "bg-surface border-border/80 text-text-muted hover:border-primary/40 hover:text-text-main"
              }`}
            >
              <ProviderIcon
                src={`/providers/${id}.png`}
                alt={name}
                size={14}
                fallbackText={(name || id).slice(0, 2).toUpperCase()}
                fallbackColor={color}
              />
              <span className="truncate max-w-[120px]">{name}</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  selectedProvider === id ? "bg-white/20 text-white" : "bg-black/5 dark:bg-white/10 text-text-muted"
                }`}
              >
                {count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Context Window & Capabilities Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-0.5">
        {/* Context Window Chips */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[11px] font-medium text-text-muted mr-1 flex items-center gap-0.5">
            <span className="material-symbols-outlined text-[13px]">dataset</span>
            Context:
          </span>
          {CONTEXT_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setContextFilter(contextFilter === opt.value ? 0 : opt.value)}
              aria-pressed={contextFilter === opt.value}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all border cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
                contextFilter === opt.value
                  ? "bg-primary/15 text-primary border-primary font-semibold"
                  : "bg-surface border-border/60 text-text-muted hover:border-primary/30 hover:text-text-main"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Capability Toggles */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFilterVision(!filterVision)}
            aria-pressed={filterVision}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all border flex items-center gap-1 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
              filterVision
                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/40 font-semibold"
                : "bg-surface border-border/60 text-text-muted hover:border-blue-500/30 hover:text-text-main"
            }`}
            title="Filter models supporting vision/image input"
          >
            <span className="material-symbols-outlined text-[13px] text-blue-500">visibility</span>
            Vision
          </button>
          <button
            onClick={() => setFilterReasoning(!filterReasoning)}
            aria-pressed={filterReasoning}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all border flex items-center gap-1 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary ${
              filterReasoning
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40 font-semibold"
                : "bg-surface border-border/60 text-text-muted hover:border-amber-500/30 hover:text-text-main"
            }`}
            title="Filter reasoning / thinking models"
          >
            <span className="material-symbols-outlined text-[13px] text-amber-500">neurology</span>
            Reasoning
          </button>
        </div>
      </div>

      {/* Filter Summary & Reset Action */}
      {(hasActiveFilters || addedSet.size > 0) && (
        <div className="flex items-center justify-between gap-2 mb-2 px-1 text-[11px] text-text-muted">
          <div className="flex items-center gap-2">
            <span>
              Showing <strong className="text-text-main font-medium">{displayedModelsCount}</strong> of {totalAvailableModels} models
            </span>
            {addedSet.size > 0 && (
              <span className="text-primary font-medium">
                • {addedSet.size} selected in combo
              </span>
            )}
          </div>
          {hasActiveFilters && (
            <button
              onClick={handleResetFilters}
              className="text-primary hover:underline font-medium inline-flex items-center gap-0.5 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary"
            >
              <span className="material-symbols-outlined text-[12px]">restart_alt</span>
              Reset filters
            </button>
          )}
        </div>
      )}

      {/* Models grouped by provider */}
      <div className="max-h-[420px] overflow-y-auto space-y-3.5 pr-0.5">
        {/* Manual custom model add from search query */}
        {searchQuery.trim() && (
          <div className="pb-2 border-b border-border/50">
            <button
              onClick={() => handleSelect({ id: searchQuery.trim(), name: searchQuery.trim(), value: searchQuery.trim(), isCustom: true })}
              className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border border-dashed border-primary/40 text-primary bg-primary/5 hover:bg-primary/10 transition-colors flex items-center justify-between gap-2 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary"
            >
              <span className="flex items-center gap-1.5 truncate">
                <span className="material-symbols-outlined text-[14px]">add_circle</span>
                <span className="truncate">
                  Add custom model: <strong className="font-mono">{searchQuery.trim()}</strong>
                </span>
              </span>
              <span className="text-[10px] text-text-muted shrink-0">Click to use</span>
            </button>
          </div>
        )}

        {/* Combos section */}
        {filteredCombos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface/95 backdrop-blur-xs py-1 z-10">
              <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
              <span className="text-xs font-medium text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo) => {
                const isSelected = selectedModel === combo.name;
                const isAdded = addedSet.has(combo.name);
                return (
                  <button
                    key={combo.id}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={`
                      px-2.5 py-1 rounded-xl text-xs font-medium transition-all border cursor-pointer flex items-center gap-1.5 focus-visible:ring-1 focus-visible:ring-primary
                      ${
                        isSelected
                          ? "bg-primary text-white border-primary shadow-xs font-semibold"
                          : isAdded
                            ? "bg-primary border-primary text-white hover:bg-primary-hover shadow-xs font-semibold"
                            : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {isAdded && (
                      <span className="material-symbols-outlined leading-none text-[11px]">check</span>
                    )}
                    <span>{combo.name}</span>
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
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface/95 backdrop-blur-xs py-1 z-10">
              <ProviderIcon
                src={`/providers/${providerId}.png`}
                alt={group.name}
                size={14}
                fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                fallbackColor={group.color}
              />
              <span className="text-xs font-medium text-primary">{group.name}</span>
              <span className="text-[10px] text-text-muted">({group.models.length})</span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {group.models.map((model) => {
                const isSelected = selectedModel === model.value;
                const isPlaceholder = model.isPlaceholder;
                const isAdded = addedSet.has(model.value);
                const caps = getCaps(model.value) || {};
                const cwLabel = formatContextWindow(caps?.contextWindow);

                return (
                  <button
                    key={model.value}
                    onClick={() => handleSelect(model)}
                    title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
                    className={`
                      px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all border cursor-pointer focus-visible:ring-1 focus-visible:ring-primary
                      ${
                        isPlaceholder
                          ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                          : isSelected
                            ? "bg-primary text-white border-primary shadow-xs font-semibold"
                            : isAdded
                              ? "bg-primary border-primary text-white hover:bg-primary-hover shadow-xs font-semibold"
                              : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    <span className="flex items-center gap-1.5">
                      {isAdded && !isPlaceholder && (
                        <span className="material-symbols-outlined leading-none text-white text-[12px]">check</span>
                      )}
                      {isPlaceholder ? (
                        <>
                          <span className="material-symbols-outlined text-[12px]">edit</span>
                          <span>{model.name}</span>
                        </>
                      ) : (
                        <>
                          <span>{model.name}</span>
                          {model.isCustom && <span className="text-[9px] opacity-60 font-normal">custom</span>}
                          {cwLabel && (
                            <span
                              className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                                isAdded || isSelected
                                  ? "bg-white/20 text-white"
                                  : "bg-black/5 dark:bg-white/10 text-text-muted border border-border/40"
                              }`}
                            >
                              {cwLabel}
                            </span>
                          )}
                          <CapacityBadges
                            caps={caps}
                            colorOverride={isAdded || isSelected ? "text-white" : undefined}
                            size={14}
                          />
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
          <div className="text-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-3xl mb-1 block opacity-60">search_off</span>
            <p className="text-xs font-medium">No models match your filters</p>
            {hasActiveFilters && (
              <button
                onClick={handleResetFilters}
                className="mt-2 text-xs text-primary hover:underline font-medium inline-flex items-center gap-1 cursor-pointer focus-visible:ring-1 focus-visible:ring-primary"
              >
                <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                Reset all filters
              </button>
            )}
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
