"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { App as AntApp, Button, Input, Modal, Segmented, Select, Table, Tooltip } from "antd";
import {
  ArrowDownOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  HolderOutlined,
  LockOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  UnlockOutlined,
} from "@ant-design/icons";
import { Card, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, StrategyHelpModal, PageHero } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelContextWindows, resolveContextWindow } from "@/shared/hooks/useModelContextWindows";
import { withClaudeCodeSuffix } from "@/shared/utils/claudeCodeModelId";
import { ACTIVE_STRATEGY_IDS } from "@/shared/constants/comboStrategies";

import AutoComboCatalog from "./AutoComboCatalog.jsx";
import ComboLocksPanel, { formatLockTimeLeft, LOCK_REASON_LABEL } from "./ComboLocksPanel.jsx";

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

const STRATEGY_LABELS = {
  fallback: "Priority Fallback",
  "round-robin": "Round Robin",
  "cache-optimized": "Cache-Optimized",
  p2c: "P2C (Latency)",
  "reset-aware": "Reset-Aware (5m)",
  "reset-window": "Reset-Window (5m)",
  headroom: "Headroom First",
  "cost-optimized": "Cost-Optimized",
  "least-used": "Least-Used",
  random: "Random",
  fusion: "Fusion Panel + Judge",
};

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Priority Fallback — try in order" },
  { value: "round-robin", label: "Round Robin — cycle evenly" },
  { value: "cache-optimized", label: "Cache-Optimized — pin prompt prefix" },
  { value: "p2c", label: "P2C — Power-of-Two-Choices" },
  { value: "reset-aware", label: "Reset-Aware — 5-minute rotation" },
  { value: "reset-window", label: "Reset-Window — 5-minute rotation" },
  { value: "headroom", label: "Headroom — most remaining quota" },
  { value: "cost-optimized", label: "Cost-Optimized — cheapest first" },
  { value: "least-used", label: "Least-Used — fewest in-flight" },
  { value: "random", label: "Random — uniform pick" },
  { value: "fusion", label: "Fusion — panel + AI Judge synthesis" },
].filter((o) => ACTIVE_STRATEGY_IDS.includes(o.value));

function getComboModelName(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") return String(entry.model || entry.id || "");
  return "";
}

function getComboModelWeight(entry) {
  if (entry && typeof entry === "object" && entry.weight !== undefined && entry.weight !== null) {
    const n = Number(entry.weight);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatContextTag(maxContext) {
  if (!maxContext || maxContext <= 0) return null;
  return maxContext >= 1000000
    ? `${(maxContext / 1000000).toFixed(1).replace(/\.0$/, "")}M`
    : `${Math.round(maxContext / 1000)}k`;
}

function getComboMaxContext(combo, modelCaps, contextByFullModel) {
  let maxCw = 0;
  for (const entry of combo?.models || []) {
    const m = getComboModelName(entry);
    const cw =
      modelCaps[m]?.contextWindow ||
      contextByFullModel[m] ||
      resolveContextWindow(contextByFullModel, m) ||
      0;
    if (cw > maxCw) maxCw = cw;
  }
  return maxCw;
}

export default function CombosPage() {
  const { message } = AntApp.useApp();
  const [combos, setCombos] = useState([]);
  const [locks, setLocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [snapshotTemplate, setSnapshotTemplate] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [selectedComboId, setSelectedComboId] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [globalComboStrategy, setGlobalComboStrategy] = useState("fallback");
  const [modelCaps, setModelCaps] = useState({});
  const [modelAliases, setModelAliases] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const [workspaceTab, setWorkspaceTab] = useState("pipelines");
  const [viewMode, setViewMode] = useState("flow");
  const [strategyFilter, setStrategyFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [unlockingModel, setUnlockingModel] = useState(null);
  const [showStrategyHelpModal, setShowStrategyHelpModal] = useState(false);
  const [strategyHelpActiveId, setStrategyHelpActiveId] = useState(null);
  const [targetComboForStrategySelect, setTargetComboForStrategySelect] = useState(null);

  const { copied, copy } = useCopyToClipboard();
  const { contextByFullModel } = useModelContextWindows();

  const loadLocks = useCallback(async () => {
    try {
      const res = await fetch("/api/combos/locks");
      if (res.ok) setLocks((await res.json()).locks || []);
    } catch {
      // ignore transient poll failures
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [combosRes, providersRes, settingsRes, modelsRes, aliasesRes, locksRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/models"),
        fetch("/api/models/alias"),
        fetch("/api/combos/locks"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const aliasesData = aliasesRes.ok ? await aliasesRes.json() : {};
      const locksData = locksRes.ok ? await locksRes.json() : {};

      if (combosRes.ok) {
        const list = (combosData.combos || []).filter((c) => !c.kind || c.kind === "llm");
        setCombos(list);
        setSelectedComboId((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0]?.id || null));
      }
      if (providersRes.ok) setActiveProviders(providersData.connections || []);
      if (aliasesRes.ok) setModelAliases(aliasesData.aliases || {});
      if (locksRes.ok) setLocks(locksData.locks || []);
      if (modelsRes.ok) {
        const md = await modelsRes.json();
        const map = {};
        for (const m of md.models || []) if (m.caps) map[m.fullModel] = m.caps;
        setModelCaps(map);
      }
      setComboStrategies(settingsData.comboStrategies || {});
      setGlobalComboStrategy(settingsData.comboStrategy || "fallback");
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const t = setInterval(loadLocks, 15000);
    return () => clearInterval(t);
  }, [loadLocks]);

  const locksByModel = useMemo(() => {
    const map = new Map();
    for (const lock of locks) {
      if (lock?.model) map.set(lock.model, lock);
    }
    return map;
  }, [locks]);

  const handleUnlockModel = useCallback(
    async (model) => {
      setUnlockingModel(model);
      try {
        await fetch("/api/combos/locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        await loadLocks();
        message.success(`Unlocked ${model}`);
      } finally {
        setUnlockingModel(null);
      }
    },
    [loadLocks, message],
  );

  const handleSyncOpencode = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync-opencode", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        const count = data.output?.match(/Found (\d+) models/)?.[1] || "models";
        message.success(`Synced ${count} models from live OpenCode catalog`);
        fetchData();
      } else {
        message.error(`Sync failed: ${data.error}`);
      }
    } catch (e) {
      message.error(`Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
        message.success(`Created combo "${data.name}"`);
      } else {
        const err = await res.json();
        message.error(err.error || "Failed to create combo");
      }
    } catch (error) {
      message.error(error.message || "Error creating combo");
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
        message.success(`Updated combo "${data.name}"`);
      } else {
        const err = await res.json();
        message.error(err.error || "Failed to update combo");
      }
    } catch (error) {
      message.error(error.message || "Error updating combo");
    }
  };

  const handleDelete = useCallback(
    (id) => {
      setConfirmState({
        title: "Delete Combo",
        message: "Delete this combo pipeline?",
        onConfirm: async () => {
          setConfirmState(null);
          try {
            const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
            if (res.ok) {
              setCombos((prev) => prev.filter((c) => c.id !== id));
              message.success("Combo deleted");
            } else {
              const err = await res.json().catch(() => ({}));
              message.error(err.error || "Failed to delete combo");
            }
          } catch (error) {
            message.error(error.message || "Failed to delete combo");
          }
        },
      });
    },
    [message],
  );

  const handleSetComboStrategy = useCallback(
    async (comboName, patch) => {
      try {
        const updated = { ...comboStrategies };
        const next = { ...(updated[comboName] || {}), ...patch };
        const globalIsFallback = !globalComboStrategy || globalComboStrategy === "fallback";
        if (!next.fallbackStrategy || (next.fallbackStrategy === "fallback" && globalIsFallback)) {
          delete updated[comboName];
        } else {
          updated[comboName] = next;
        }

        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comboStrategies: updated }),
        });
        setComboStrategies(updated);
      } catch (error) {
        console.log("Error updating combo strategy:", error);
      }
    },
    [comboStrategies, globalComboStrategy],
  );

  const handleOpenStrategyHelp = (strategyId = null, comboName = null) => {
    setStrategyHelpActiveId(strategyId || "fallback");
    setTargetComboForStrategySelect(comboName);
    setShowStrategyHelpModal(true);
  };

  const handleSelectStrategyFromModal = (newStrategyId) => {
    if (targetComboForStrategySelect) {
      handleSetComboStrategy(targetComboForStrategySelect, { fallbackStrategy: newStrategyId });
    }
  };

  const handleSnapshotTemplate = (tpl) => {
    setSnapshotTemplate({
      name: tpl.name,
      models: [],
      strategy: tpl.strategy,
    });
    setShowCreateModal(true);
  };

  const totalHops = useMemo(
    () => combos.reduce((acc, c) => acc + (Array.isArray(c.models) ? c.models.length : 0), 0),
    [combos],
  );

  const strategyBreakdown = useMemo(() => {
    const counts = { fallback: 0, "round-robin": 0, "cache-optimized": 0, p2c: 0, fusion: 0, other: 0 };
    combos.forEach((c) => {
      const s = comboStrategies[c.name]?.fallbackStrategy || globalComboStrategy || "fallback";
      if (s in counts) counts[s] += 1;
      else counts.other += 1;
    });
    return counts;
  }, [combos, comboStrategies, globalComboStrategy]);

  const filteredCombos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return combos.filter((combo) => {
      const strat = comboStrategies[combo.name]?.fallbackStrategy || globalComboStrategy || "fallback";
      if (strategyFilter === "other") {
        if (["fallback", "round-robin", "p2c", "cache-optimized", "fusion"].includes(strat)) return false;
      } else if (strategyFilter !== "all" && strat !== strategyFilter) {
        return false;
      }
      if (!q) return true;
      return (
        combo.name.toLowerCase().includes(q) ||
        (Array.isArray(combo.models) && combo.models.some((m) => getComboModelName(m).toLowerCase().includes(q)))
      );
    });
  }, [combos, comboStrategies, globalComboStrategy, strategyFilter, searchQuery]);

  const selectedCombo = useMemo(
    () =>
      filteredCombos.find((c) => c.id === selectedComboId) ||
      combos.find((c) => c.id === selectedComboId) ||
      filteredCombos[0] ||
      null,
    [filteredCombos, combos, selectedComboId],
  );

  const matrixColumns = useMemo(
    () => [
      {
        title: "Virtual Alias",
        key: "name",
        width: 220,
        render: (_, combo) => {
          const maxCtx = getComboMaxContext(combo, modelCaps, contextByFullModel);
          const ctxTag = formatContextTag(maxCtx);
          const copyText = withClaudeCodeSuffix(combo.name, maxCtx);
          return (
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copy(copyText, `combo-${combo.id}`);
                }}
                className="inline-flex items-center gap-1 rounded border border-border bg-bg-alt px-2 py-0.5 font-mono text-xs font-semibold text-text-main hover:border-text-main cursor-pointer"
                title={`Copy "${copyText}"`}
              >
                <span>{combo.name}</span>
                {copied === `combo-${combo.id}` && (
                  <span className="text-[10px] font-sans text-[#6c8618] dark:text-[#a6c23f]">Copied</span>
                )}
              </button>
              {ctxTag && (
                <span className="rounded border border-border bg-bg-alt px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                  {ctxTag}
                </span>
              )}
            </div>
          );
        },
      },
      {
        title: "Hop Conduit",
        key: "models",
        render: (_, combo) => (
          <div className="flex flex-wrap items-center gap-1.5">
            {(combo.models || []).slice(0, 3).map((entry, idx) => {
              const modelName = getComboModelName(entry);
              const weight = getComboModelWeight(entry);
              const locked = locksByModel.get(modelName);
              return (
                <span
                  key={`${modelName}-${idx}`}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                    locked
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "border-border bg-bg-alt text-text-main"
                  }`}
                >
                  <span className="text-text-subtle">{String(idx + 1).padStart(2, "0")}</span>
                  <span className="truncate max-w-[160px]">{modelName}</span>
                  {weight !== null && <span className="text-text-muted">({weight}%)</span>}
                  {locked && <LockOutlined className="text-[10px] text-amber-500" />}
                </span>
              );
            })}
            {(combo.models?.length || 0) > 3 && (
              <span className="font-mono text-[11px] text-text-muted">+{combo.models.length - 3}</span>
            )}
          </div>
        ),
      },
      {
        title: "Strategy",
        key: "strategy",
        width: 210,
        render: (_, combo) => {
          const current = comboStrategies[combo.name]?.fallbackStrategy || globalComboStrategy || "fallback";
          return (
            <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
              <Select
                size="small"
                value={current}
                onChange={(val) => handleSetComboStrategy(combo.name, { fallbackStrategy: val })}
                options={STRATEGY_OPTIONS}
                className="w-full min-w-[155px]"
              />
              <Button
                size="small"
                icon={<QuestionCircleOutlined />}
                onClick={() => handleOpenStrategyHelp(current, combo.name)}
                aria-label="Strategy Guide"
              />
            </div>
          );
        },
      },
      {
        title: "Health",
        key: "health",
        width: 110,
        render: (_, combo) => {
          const lockedCount = (combo.models || []).filter((e) => locksByModel.has(getComboModelName(e))).length;
          return lockedCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
              <LockOutlined />
              {lockedCount} locked
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted font-medium">
              <span className="size-1.5 rounded-full bg-[#a6c23f]" />
              Ready
            </span>
          );
        },
      },
      {
        title: "Actions",
        key: "actions",
        align: "right",
        width: 135,
        render: (_, combo) => (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Tooltip title="Inspect hops">
              <Button
                size="small"
                type={selectedCombo?.id === combo.id ? "primary" : "default"}
                icon={<EyeOutlined />}
                onClick={() => setSelectedComboId(combo.id)}
              />
            </Tooltip>
            <Tooltip title="Edit pipeline">
              <Button size="small" icon={<EditOutlined />} onClick={() => setEditingCombo(combo)} />
            </Tooltip>
            <Tooltip title="Delete pipeline">
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(combo.id)} />
            </Tooltip>
          </div>
        ),
      },
    ],
    [
      modelCaps,
      contextByFullModel,
      copied,
      copy,
      locksByModel,
      comboStrategies,
      globalComboStrategy,
      handleSetComboStrategy,
      handleDelete,
      selectedCombo,
    ],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <PageHero
        title="Model Combo Pipelines"
        description="Orchestrate multi-provider failover conduits, weighted load distribution, and Fusion panels under single virtual model aliases."
        icon={<NodeIndexOutlined />}
        badge={{
          text:
            locks.length > 0
              ? `${combos.length} Pipelines · ${locks.length} Hop Lock${locks.length > 1 ? "s" : ""}`
              : `${combos.length} Active Pipelines`,
        }}
        stats={[
          { label: "Active Pipelines", value: combos.length },
          { label: "Total Model Hops", value: totalHops },
          { label: "Default Strategy", value: STRATEGY_LABELS[globalComboStrategy] || (globalComboStrategy || "fallback").toUpperCase() },
          { label: "Circuit Locks", value: locks.length, suffix: locks.length > 0 ? "paused" : "clean" },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="small"
              icon={<ReloadOutlined spin={syncing} />}
              onClick={handleSyncOpencode}
              disabled={syncing}
            >
              {syncing ? "Syncing..." : "Sync OpenCode"}
            </Button>
            <Button
              size="small"
              icon={<BookOutlined />}
              onClick={() => handleOpenStrategyHelp(null, null)}
            >
              Strategy Guide
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setShowCreateModal(true)}
            >
              Create Combo
            </Button>
          </div>
        }
        toolbar={
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between w-full min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 min-w-0">
              <div className="max-w-full overflow-x-auto pb-0.5">
                <Segmented
                  size="small"
                  value={workspaceTab}
                  onChange={setWorkspaceTab}
                  options={[
                    { label: `Pipelines (${combos.length})`, value: "pipelines" },
                    { label: "Auto Routes (7)", value: "auto" },
                  ]}
                />
              </div>

              {workspaceTab === "pipelines" && (
                <div className="max-w-full overflow-x-auto pb-0.5">
                  <Segmented
                    size="small"
                    value={strategyFilter}
                    onChange={setStrategyFilter}
                    options={[
                      { label: `All (${combos.length})`, value: "all" },
                      { label: "Fallback", value: "fallback" },
                      { label: "Round Robin", value: "round-robin" },
                      { label: "Cache-Opt", value: "cache-optimized" },
                      { label: "P2C", value: "p2c" },
                      { label: "Fusion", value: "fusion" },
                      { label: "Other", value: "other" },
                    ]}
                  />
                </div>
              )}
            </div>

            {workspaceTab === "pipelines" && (
              <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
                <div className="w-full sm:w-64">
                  <Input
                    allowClear
                    size="small"
                    prefix={<SearchOutlined className="text-text-muted" />}
                    placeholder="Filter combos or hop models..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Segmented
                  size="small"
                  value={viewMode}
                  onChange={setViewMode}
                  options={[
                    { label: "Flow", value: "flow" },
                    { label: "Matrix", value: "matrix" },
                  ]}
                />
              </div>
            )}
          </div>
        }
      />

      {workspaceTab === "auto" ? (
        <AutoComboCatalog
          embedded
          defaultOpen
          onDuplicate={handleSnapshotTemplate}
          onCopy={copy}
          copiedId={copied}
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
          {/* Left Zone: Pipeline Studio (Flow Cards or Matrix Table) */}
          <div className="min-w-0 flex flex-col gap-3">
            {combos.length === 0 ? (
              <Card className="border border-border bg-surface">
                <div className="text-center py-12">
                  <div className="inline-flex items-center justify-center size-11 rounded-xl bg-surface-2 text-text-main border border-border mb-3">
                    <NodeIndexOutlined className="text-lg" />
                  </div>
                  <p className="text-sm font-semibold text-text-main m-0">No combo pipelines configured</p>
                  <p className="text-xs text-text-muted mt-1 mb-4">
                    Create virtual model aliases backed by ordered failover hops or weighted pools.
                  </p>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreateModal(true)}>
                    Create Combo
                  </Button>
                </div>
              </Card>
            ) : filteredCombos.length === 0 ? (
              <Card className="border border-border bg-surface">
                <div className="text-center py-10">
                  <p className="text-sm font-medium text-text-main m-0">
                    No combos match &ldquo;{searchQuery || strategyFilter}&rdquo;
                  </p>
                  <p className="text-xs text-text-muted mt-1 mb-3">
                    Reset filters to inspect all {combos.length} configured pipelines.
                  </p>
                  <Button
                    size="small"
                    onClick={() => {
                      setStrategyFilter("all");
                      setSearchQuery("");
                    }}
                  >
                    Reset Filters
                  </Button>
                </div>
              </Card>
            ) : viewMode === "matrix" ? (
              <div className="rounded-xl border border-border bg-surface overflow-hidden">
                <Table
                  size="small"
                  bordered
                  rowKey="id"
                  columns={matrixColumns}
                  dataSource={filteredCombos}
                  pagination={false}
                  scroll={{ x: 820 }}
                  onRow={(record) => ({
                    onClick: () => setSelectedComboId(record.id),
                    className: "cursor-pointer",
                  })}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredCombos.map((combo) => (
                  <ComboCard
                    key={combo.id}
                    combo={combo}
                    isSelected={selectedCombo?.id === combo.id}
                    onSelect={() => setSelectedComboId(combo.id)}
                    locksByModel={locksByModel}
                    modelCaps={modelCaps}
                    contextByFullModel={contextByFullModel}
                    activeProviders={activeProviders}
                    modelAliases={modelAliases}
                    copied={copied}
                    onCopy={copy}
                    onEdit={() => setEditingCombo(combo)}
                    onDelete={() => handleDelete(combo.id)}
                    strategy={comboStrategies[combo.name] || {}}
                    defaultStrategy={globalComboStrategy}
                    onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
                    onOpenStrategyHelp={handleOpenStrategyHelp}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Right Sticky Inspector Rail: Selected Pipeline Blueprint + Locks + Strategy Mix */}
          <aside className="flex flex-col gap-4 xl:sticky xl:top-4">
            {selectedCombo && (
              <PipelineBlueprintInspector
                combo={selectedCombo}
                strategy={comboStrategies[selectedCombo.name] || {}}
                defaultStrategy={globalComboStrategy}
                locksByModel={locksByModel}
                modelCaps={modelCaps}
                contextByFullModel={contextByFullModel}
                copied={copied}
                onCopy={copy}
                onEdit={() => setEditingCombo(selectedCombo)}
                onUnlock={handleUnlockModel}
                unlockingModel={unlockingModel}
              />
            )}

            <ComboLocksPanel locks={locks} onRefresh={loadLocks} />

            <Card padding="sm" className="border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border-subtle pb-2.5 mb-3">
                <div>
                  <div className="text-xs font-semibold text-text-main">Strategy Mix</div>
                  <div className="text-[11px] text-text-muted">Click to filter pipeline routing</div>
                </div>
                <span className="rounded bg-bg-alt border border-border px-2 py-0.5 text-[11px] font-mono text-text-main tabular-nums">
                  {combos.length}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: "fallback", label: "Fallback", dot: "bg-text-main" },
                  { id: "round-robin", label: "Round Robin", dot: "bg-text-muted" },
                  { id: "cache-optimized", label: "Cache-Opt", dot: "bg-[#a6c23f]" },
                  { id: "p2c", label: "P2C", dot: "bg-text-subtle" },
                  { id: "fusion", label: "Fusion", dot: "bg-text-main" },
                  { id: "other", label: "Other", dot: "bg-border-strong" },
                ].map((s) => {
                  const count = strategyBreakdown[s.id] || 0;
                  const active = strategyFilter === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setStrategyFilter(active ? "all" : s.id)}
                      className={`flex items-center justify-between rounded-lg border px-2.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                        active
                          ? "border-text-main bg-surface-2 text-text-main font-medium"
                          : "border-border bg-bg-alt/60 text-text-muted hover:text-text-main hover:bg-surface-2/60"
                      }`}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <span className={`size-2 rounded-full ${s.dot}`} />
                        <span className="truncate">{s.label}</span>
                      </span>
                      <span className="font-mono font-semibold text-text-main tabular-nums">{count}</span>
                    </button>
                  );
                })}
              </div>
            </Card>
          </aside>
        </div>
      )}

      {showCreateModal && (
        <ComboFormModal
          key={snapshotTemplate?.name || "create"}
          isOpen={showCreateModal}
          onClose={() => {
            setShowCreateModal(false);
            setSnapshotTemplate(null);
          }}
          onSave={(data) => {
            setSnapshotTemplate(null);
            return handleCreate(data);
          }}
          activeProviders={activeProviders}
          initialName={snapshotTemplate?.name}
        />
      )}

      {!!editingCombo && (
        <ComboFormModal
          key={editingCombo?.id || "new"}
          isOpen={!!editingCombo}
          combo={editingCombo}
          onClose={() => setEditingCombo(null)}
          onSave={(data) => handleUpdate(editingCombo.id, data)}
          activeProviders={activeProviders}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      <StrategyHelpModal
        isOpen={showStrategyHelpModal}
        onClose={() => {
          setShowStrategyHelpModal(false);
          setTargetComboForStrategySelect(null);
        }}
        selectedStrategy={strategyHelpActiveId}
        onSelectStrategy={targetComboForStrategySelect ? handleSelectStrategyFromModal : null}
      />
    </div>
  );
}

function PipelineBlueprintInspector({
  combo,
  strategy = {},
  defaultStrategy = "fallback",
  locksByModel,
  modelCaps = {},
  contextByFullModel = {},
  copied,
  onCopy,
  onEdit,
  onUnlock,
  unlockingModel,
}) {
  const currentStrat = strategy.fallbackStrategy || defaultStrategy || "fallback";
  const maxContext = getComboMaxContext(combo, modelCaps, contextByFullModel);
  const ctxTag = formatContextTag(maxContext);
  const copyText = withClaudeCodeSuffix(combo.name, maxContext);
  const models = Array.isArray(combo.models) ? combo.models : [];

  return (
    <Card padding="sm" className="border border-border bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-border-subtle pb-2.5 mb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-text-muted">Pipeline Blueprint</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
            <code className="font-mono text-sm font-semibold text-text-main truncate">{combo.name}</code>
            {ctxTag && (
              <span className="rounded border border-border bg-bg-alt px-1.5 py-0.2 font-mono text-[10px] text-text-muted">
                {ctxTag}
              </span>
            )}
          </div>
        </div>
        <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
          Edit
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-alt px-2.5 py-2 mb-3 text-[11px]">
        <span className="text-text-muted">Strategy</span>
        <span className="font-mono font-semibold text-text-main">
          {STRATEGY_LABELS[currentStrat] || currentStrat}
        </span>
      </div>

      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-0.5">
        {models.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-text-muted">
            No static hops defined. Click Edit to add model targets.
          </div>
        ) : (
          models.map((entry, idx) => {
            const modelName = getComboModelName(entry);
            const weight = getComboModelWeight(entry);
            const lock = locksByModel.get(modelName);
            return (
              <div
                key={`${modelName}-${idx}`}
                className={`rounded-lg border px-2.5 py-2 text-xs ${
                  lock
                    ? "border-amber-500/35 bg-amber-500/5"
                    : "border-border-subtle bg-bg-alt/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`inline-flex h-4 px-1.5 items-center justify-center rounded font-mono text-[10px] font-semibold shrink-0 ${
                        idx === 0
                          ? "bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111]"
                          : "bg-surface border border-border text-text-muted"
                      }`}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <code className="font-mono text-[11px] font-medium text-text-main truncate">
                      {modelName}
                    </code>
                  </div>
                  {weight !== null && (
                    <span className="font-mono text-[10px] text-text-muted shrink-0 tabular-nums">
                      {weight}%
                    </span>
                  )}
                </div>

                {weight !== null && (
                  <div className="mt-1.5 h-1 w-full rounded-full bg-surface overflow-hidden border border-border-subtle">
                    <div
                      className="h-full bg-text-main rounded-full"
                      style={{ width: `${Math.min(100, Math.max(2, weight))}%` }}
                    />
                  </div>
                )}

                {lock && (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
                    <span className="text-amber-700 dark:text-amber-300 font-mono">
                      {LOCK_REASON_LABEL[lock.reason] || lock.reason} · {formatLockTimeLeft(lock.until)} left
                    </span>
                    <Button
                      size="small"
                      icon={<UnlockOutlined />}
                      loading={unlockingModel === modelName}
                      onClick={() => onUnlock(modelName)}
                    >
                      Unlock
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 pt-2.5 border-t border-border-subtle flex items-center justify-between gap-2">
        <code className="text-[11px] font-mono text-text-muted truncate" title={copyText}>
          model: &ldquo;{copyText}&rdquo;
        </code>
        <Button
          size="small"
          icon={copied === `insp-${combo.id}` ? <CheckOutlined /> : <CopyOutlined />}
          onClick={() => onCopy(copyText, `insp-${combo.id}`)}
        >
          {copied === `insp-${combo.id}` ? "Copied" : "Copy ID"}
        </Button>
      </div>
    </Card>
  );
}

function ComboCard({
  combo,
  isSelected = false,
  onSelect,
  locksByModel,
  modelCaps = {},
  contextByFullModel = {},
  activeProviders = [],
  modelAliases = {},
  copied,
  onCopy,
  onEdit,
  onDelete,
  strategy = {},
  defaultStrategy = "fallback",
  onSetStrategy,
  onOpenStrategyHelp,
}) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const current = strategy.fallbackStrategy || defaultStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";

  const maxContext = getComboMaxContext(combo, modelCaps, contextByFullModel);
  const ctxTag = formatContextTag(maxContext);
  const copyText = withClaudeCodeSuffix(combo.name, maxContext);
  const lockedCount = (combo.models || []).filter((e) => locksByModel.has(getComboModelName(e))).length;

  return (
    <Card
      padding="none"
      onClick={onSelect}
      className={`group relative overflow-hidden border bg-surface transition-colors cursor-pointer ${
        isSelected
          ? "border-text-main shadow-[0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-none"
          : "border-border hover:border-border-strong"
      }`}
    >
      <div className="p-4 flex min-w-0 flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="size-10 rounded-lg bg-bg-alt border border-border flex flex-col items-center justify-center shrink-0">
            <NodeIndexOutlined className="text-sm text-text-main" />
            <span className="text-[9px] font-mono text-text-muted leading-none mt-0.5 tabular-nums">
              {combo.models.length}h
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy(copyText, `combo-${combo.id}`);
                }}
                className="inline-flex items-center gap-1.5 cursor-pointer truncate rounded-lg bg-bg-alt border border-border px-2.5 py-0.5 font-mono text-sm font-semibold text-text-main hover:border-text-main transition-colors"
                title={`Click to copy combo name (${copyText})`}
              >
                <span>{combo.name}</span>
                {copied === `combo-${combo.id}` && (
                  <span className="text-[10px] font-sans font-medium text-[#6c8618] dark:text-[#a6c23f]">
                    Copied
                  </span>
                )}
              </button>

              {ctxTag && (
                <span className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[11px] bg-bg-alt text-text-main border border-border">
                  {ctxTag}
                </span>
              )}

              <span
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                  lockedCount > 0
                    ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-border bg-bg-alt text-text-muted"
                }`}
              >
                {lockedCount > 0 ? (
                  <>
                    <LockOutlined className="text-[10px] text-amber-500" />
                    <span>{lockedCount} paused</span>
                  </>
                ) : (
                  <>
                    <span className="size-1.5 rounded-full bg-[#a6c23f]" />
                    <span>{combo.models.length} {combo.models.length === 1 ? "node" : "hops"}</span>
                  </>
                )}
              </span>
            </div>

            {/* Directed Hop Conduit */}
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No pipeline hops configured</span>
              ) : (
                combo.models.slice(0, 3).map((entry, index) => {
                  const modelName = getComboModelName(entry);
                  const weight = getComboModelWeight(entry);
                  const lock = locksByModel.get(modelName);

                  return (
                    <div key={`${modelName}-${index}`} className="inline-flex items-center gap-2 min-w-0">
                      {index > 0 && (
                        <ArrowRightOutlined className="text-[11px] text-text-subtle shrink-0" />
                      )}
                      <div
                        className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] text-text-main ${
                          lock
                            ? "border-amber-500/40 bg-amber-500/10"
                            : "border-border bg-bg-alt"
                        }`}
                      >
                        <span
                          className={`inline-flex h-4 px-1.5 items-center justify-center rounded font-mono text-[10px] font-semibold ${
                            index === 0
                              ? "bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111]"
                              : "bg-surface border border-border text-text-muted"
                          }`}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <code className="font-mono truncate max-w-[200px]">{modelName}</code>
                        {weight !== null && (
                          <span className="rounded bg-surface border border-border px-1.5 font-mono text-[10px] text-text-muted tabular-nums">
                            {weight}%
                          </span>
                        )}
                        {lock && (
                          <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
                            <LockOutlined className="text-[10px]" />
                            {formatLockTimeLeft(lock.until)}
                          </span>
                        )}
                        <CapacityBadges caps={modelCaps[modelName]} />
                      </div>
                    </div>
                  );
                })
              )}
              {combo.models.length > 3 && (
                <span className="inline-flex items-center rounded-lg border border-dashed border-border px-2.5 py-1 font-mono text-[11px] text-text-muted">
                  +{combo.models.length - 3} more
                </span>
              )}
            </div>

            {isFusion && (
              <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <span className="text-[11px] font-medium text-text-muted">Fusion Judge:</span>
                <Button size="small" onClick={() => setShowJudgeSelect(true)} className="font-mono text-[11px]">
                  {judge || `Auto — ${getComboModelName(combo.models[0]) || "first model"}`}
                </Button>
                {judge && (
                  <Button
                    size="small"
                    danger
                    icon={<CloseOutlined />}
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    title="Reset judge to Auto"
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div
          className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center lg:gap-2 lg:shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 w-full lg:w-[220px]">
            <Select
              size="small"
              value={current}
              onChange={(val) => onSetStrategy({ fallbackStrategy: val })}
              options={STRATEGY_OPTIONS}
              className="flex-1 min-w-0"
            />
            {onOpenStrategyHelp && (
              <Tooltip title="Strategy Guide & Details">
                <Button
                  size="small"
                  icon={<QuestionCircleOutlined />}
                  onClick={() => onOpenStrategyHelp(current, combo.name)}
                  aria-label="Strategy Guide"
                />
              </Tooltip>
            )}
          </div>

          <div className="flex items-center gap-1 justify-end">
            <Tooltip title={`Copy combo ID (${copyText})`}>
              <Button
                size="small"
                icon={copied === `combo-${combo.id}` ? <CheckOutlined /> : <CopyOutlined />}
                onClick={() => onCopy(copyText, `combo-${combo.id}`)}
              />
            </Tooltip>
            <Tooltip title="Edit pipeline">
              <Button size="small" icon={<EditOutlined />} onClick={onEdit} />
            </Tooltip>
            <Tooltip title="Delete pipeline">
              <Button size="small" danger icon={<DeleteOutlined />} onClick={onDelete} />
            </Tooltip>
          </div>
        </div>
      </div>

      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => {
            onSetStrategy({ judgeModel: m?.value || "" });
            setShowJudgeSelect(false);
          }}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Judge Model"
          addedModelValues={judge ? [judge] : []}
          closeOnSelect={true}
        />
      )}
    </Card>
  );
}

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const modelName = getComboModelName(model);
  const weight = getComboModelWeight(model);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(modelName);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== modelName) {
      onEdit(weight !== null && typeof model === "object" ? { ...model, model: trimmed } : trimmed);
    } else {
      setDraft(modelName);
    }
    setEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 bg-bg-alt hover:border-border transition-colors ${
        isDragging ? "shadow-md ring-1 ring-text-main/30" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-text-main active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <HolderOutlined />
      </button>

      <span className="font-mono text-[10px] font-semibold text-text-muted w-5 text-center shrink-0 tabular-nums">
        {String(index + 1).padStart(2, "0")}
      </span>

      {editing ? (
        <Input
          size="small"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPressEnter={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(modelName);
              setEditing(false);
            }
          }}
          className="font-mono text-xs flex-1 min-w-0"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-surface"
          onClick={() => setEditing(true)}
          title="Click to edit model ID"
        >
          {modelName}
          {weight !== null ? ` (${weight}%)` : ""}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={isFirst} onClick={onMoveUp} title="Move up" />
        <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={isLast} onClick={onMoveDown} title="Move down" />
        <Button size="small" type="text" danger icon={<CloseOutlined />} onClick={onRemove} title="Remove" />
      </div>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, initialName }) {
  const [name, setName] = useState(combo?.name || initialName || "");
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/models/alias")
      .then((res) => (res.ok ? res.json() : {}))
      .then((data) => setModelAliases(data.aliases || {}))
      .catch(() => {});
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.some((m) => getComboModelName(m) === model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => getComboModelName(m) !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const next = [...models];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setModels(next);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const next = [...models];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setModels(next);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    await onSave({ name: name.trim(), models });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        open={isOpen}
        onCancel={onClose}
        footer={null}
        destroyOnHidden
        width={540}
        title={isEdit ? "Edit Combo Pipeline" : "Create Combo Pipeline"}
      >
        <div className="flex flex-col gap-4 pt-2">
          <div>
            <label className="text-xs font-semibold text-text-main mb-1.5 block">Combo Name</label>
            <Input
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              status={nameError ? "error" : undefined}
              className="font-mono"
            />
            <p className={`text-[11px] mt-1 mb-0 ${nameError ? "text-red-500" : "text-text-muted"}`}>
              {nameError || "Only letters, numbers, -, _ and . allowed"}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-text-main">Pipeline Hops ({models.length})</label>
              <Button size="small" icon={<PlusOutlined />} onClick={() => setShowModelSelect(true)}>
                Add Model
              </Button>
            </div>

            {models.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-border rounded-lg bg-bg-alt/50">
                <p className="text-xs text-text-muted m-0">No model hops added yet.</p>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              >
                <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                  <div className="flex max-h-[45vh] min-w-0 flex-col gap-1.5 overflow-y-auto pr-0.5">
                    {modelItems.map(({ uid, model }, index) => (
                      <ModelItem
                        key={uid}
                        id={uid}
                        index={index}
                        model={model}
                        isFirst={index === 0}
                        isLast={index === modelItems.length - 1}
                        onEdit={(newVal) => {
                          const updated = [...models];
                          updated[index] = newVal;
                          setModels(updated);
                        }}
                        onMoveUp={() => handleMoveUp(index)}
                        onMoveDown={() => handleMoveDown(index)}
                        onRemove={() => handleRemoveModel(index)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              onClick={handleSave}
              loading={saving}
              disabled={!name.trim() || !!nameError}
            >
              {isEdit ? "Save Changes" : "Create Pipeline"}
            </Button>
          </div>
        </div>
      </Modal>

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleAddModel}
          onDeselect={handleDeselectModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Add Model to Combo"
          kindFilter={kindFilter}
          addedModelValues={models.map(getComboModelName)}
          closeOnSelect={false}
        />
      )}
    </>
  );
}
