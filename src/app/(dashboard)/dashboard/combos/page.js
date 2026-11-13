"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, StrategyHelpModal, PageHero } from "@/shared/components";
import { Input as AntInput, Segmented } from "antd";
import { NodeIndexOutlined, PlusOutlined, ReloadOutlined, BookOutlined, SearchOutlined } from "@ant-design/icons";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelContextWindows, resolveContextWindow } from "@/shared/hooks/useModelContextWindows";
import { withClaudeCodeSuffix } from "@/shared/utils/claudeCodeModelId";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { ACTIVE_STRATEGY_IDS } from "@/shared/constants/comboStrategies";

import AutoComboCatalog from "./AutoComboCatalog.jsx";
import ComboLocksPanel from "./ComboLocksPanel.jsx";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Template being snapshotted into the create modal (from AutoComboCatalog)
  const [snapshotTemplate, setSnapshotTemplate] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [globalComboStrategy, setGlobalComboStrategy] = useState("fallback");
  const [modelCaps, setModelCaps] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();
  const { contextByFullModel } = useModelContextWindows();
  const [strategyFilter, setStrategyFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [modelAliases, setModelAliases] = useState({});

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes, modelsRes, aliasesRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/models"),
        fetch("/api/models/alias"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const aliasesData = aliasesRes.ok ? await aliasesRes.json() : {};
      
      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter(c => !c.kind || c.kind === "llm"));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      if (aliasesRes.ok) {
        setModelAliases(aliasesData.aliases || {});
      }
      if (modelsRes.ok) {
        const md = await modelsRes.json();
        // Build fullModel -> caps map for badge lookup
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
  };

  const handleSyncOpencode = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync-opencode", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        alert("Synced " + (data.output?.match(/Found (\d+) models/)?.[1] || "models") + " from live catalog");
        fetchData();
      } else {
        alert("Sync failed: " + data.error);
      }
    } catch (e) {
      alert("Sync failed: " + e.message);
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
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create combo");
      }
    } catch (error) {
      console.log("Error creating combo:", error);
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
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update combo");
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Combo",
      message: "Delete this combo?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            setCombos(combos.filter(c => c.id !== id));
          }
        } catch (error) {
          console.log("Error deleting combo:", error);
        }
      }
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies. Passing an empty
  // patch (strategy back to default "fallback") drops the entry entirely.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Prune only when dropping the entry is a no-op. A missing entry makes the
      // gateway use the GLOBAL comboStrategy, so when that is not "fallback" an
      // explicit "fallback" must be persisted or the combo silently rotates.
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
  };

  const [showStrategyHelpModal, setShowStrategyHelpModal] = useState(false);
  const [strategyHelpActiveId, setStrategyHelpActiveId] = useState(null);
  const [targetComboForStrategySelect, setTargetComboForStrategySelect] = useState(null);

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
    setShowCreateModal(true);
    setSnapshotTemplate({
      name: tpl.name,
      models: [], // virtual combos have no static members; the API resolves them at request time
      strategy: tpl.strategy,
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const totalHops = useMemo(
    () => combos.reduce((acc, c) => acc + (Array.isArray(c.models) ? c.models.length : 0), 0),
    [combos]
  );

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
        (Array.isArray(combo.models) && combo.models.some((m) => String(m).toLowerCase().includes(q)))
      );
    });
  }, [combos, comboStrategies, globalComboStrategy, strategyFilter, searchQuery]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <PageHero
        eyebrow="NEURAL ROUTING PIPELINES · COMBO ORCHESTRATOR"
        title="Model Combo Pipelines"
        description="Orchestrate multi-provider model failover chains, cache-affinity pools, and LLM fusion panels under single virtual model aliases."
        icon={<NodeIndexOutlined />}
        accent="cyan"
        badge={{
          label: `${combos.length} ACTIVE PIPELINES`,
          color: "cyan",
          pulse: combos.length > 0,
        }}
        stats={[
          { label: "Active Combos", value: combos.length, color: "#06b6d4" },
          { label: "Total Model Hops", value: totalHops, color: "#f59e0b" },
          { label: "Default Strategy", value: (globalComboStrategy || "fallback").toUpperCase(), color: "#10b981" },
          { label: "Active Providers", value: activeProviders.length, color: "#a855f7" },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSyncOpencode}
              disabled={syncing}
              className="whitespace-nowrap"
            >
              <ReloadOutlined className={`mr-1 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing..." : "Sync OpenCode"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleOpenStrategyHelp(null, null)}
              className="whitespace-nowrap"
              title="Load Balancing & Failover Strategy Guide"
            >
              <BookOutlined className="mr-1" />
              Strategy Guide
            </Button>
            <Button size="sm" onClick={() => setShowCreateModal(true)} className="whitespace-nowrap">
              <PlusOutlined className="mr-1" />
              Create Combo
            </Button>
          </div>
        }
        toolbar={
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="overflow-x-auto">
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
            <div className="w-full lg:w-72">
              <AntInput
                allowClear
                size="small"
                prefix={<SearchOutlined className="text-text-muted" />}
                placeholder="Filter combos or hop models..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
        }
      />

      {/* Zero-config auto/* templates (OmniRoute parity) — call directly without saving */}
      <ComboLocksPanel />

      <AutoComboCatalog onDuplicate={handleSnapshotTemplate} onCopy={copy} copiedId={copied} />

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card className="hyperion-card">
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">No combos yet</p>
            <p className="text-sm text-text-muted mb-4">Create model combos with failover and smart routing pipelines</p>
            <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
              Create Combo
            </Button>
          </div>
        </Card>
      ) : filteredCombos.length === 0 ? (
        <Card className="hyperion-card">
          <div className="text-center py-10">
            <p className="text-sm font-medium text-text-main">No combos match &ldquo;{searchQuery || strategyFilter}&rdquo;</p>
            <p className="text-xs text-text-muted mt-1 mb-3">Reset filters to view all {combos.length} configured pipelines.</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setStrategyFilter("all");
                setSearchQuery("");
              }}
            >
              Reset Filters
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-3.5">
          {filteredCombos.map((combo) => (
            <ComboCard
              key={combo.id}
              combo={combo}
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

      {/* Create Modal - Lazy mounted */}
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

      {/* Edit Modal - Lazy mounted */}
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

      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {/* Strategy Help Modal */}
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

// Every strategy the gateway implements (see STRATEGY_DETAILS for the full
// list). Derived from the shared constants so the select can never drift from
// the backend.
const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Priority Fallback — try in order 🥇" },
  { value: "round-robin", label: "Round Robin — cycle evenly 🔄" },
  { value: "cache-optimized", label: "Cache-Optimized — pin prompt prefix for 90% cache hits 🎯" },
  { value: "p2c", label: "P2C — Power-of-Two-Choices ⚡" },
  { value: "reset-aware", label: "Reset-Aware — 5-minute rotation 📊" },
  { value: "reset-window", label: "Reset-Window — 5-minute rotation 📊" },
  { value: "headroom", label: "Headroom — most remaining quota first 🔋" },
  { value: "cost-optimized", label: "Cost-Optimized — cheapest first 💰" },
  { value: "least-used", label: "Least-Used — fewest in-flight first ⚖️" },
  { value: "random", label: "Random — uniform pick 🎲" },
  { value: "fusion", label: "Fusion — fan-out panel + AI Judge synthesis 🧬" },
].filter((o) => ACTIVE_STRATEGY_IDS.includes(o.value));

function ComboCard({ combo, modelCaps = {}, contextByFullModel = {}, activeProviders = [], modelAliases = {}, copied, onCopy, onEdit, onDelete, strategy = {}, defaultStrategy = "fallback", onSetStrategy, onOpenStrategyHelp }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  // Show the strategy the gateway actually runs: per-combo entry, else the global one.
  const current = strategy.fallbackStrategy || defaultStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";

  const maxContext = useMemo(() => {
    let maxCw = 0;
    for (const m of combo.models || []) {
      const cw = modelCaps[m]?.contextWindow ||
                 contextByFullModel[m] ||
                 resolveContextWindow(contextByFullModel, m) ||
                 0;
      if (cw > maxCw) maxCw = cw;
    }
    return maxCw;
  }, [combo.models, modelCaps, contextByFullModel]);

  const copyText = withClaudeCodeSuffix(combo.name, maxContext);

  const stratColorMap = {
    fallback: "from-amber-400/80 via-cyan-400/70 to-emerald-400/70",
    "round-robin": "from-cyan-400/80 via-sky-400/70 to-indigo-400/70",
    p2c: "from-violet-400/80 via-fuchsia-400/70 to-cyan-400/70",
    "cache-optimized": "from-emerald-400/80 via-teal-400/70 to-cyan-400/70",
    fusion: "from-fuchsia-500/85 via-amber-400/75 to-cyan-400/75",
  };
  const topStrip = stratColorMap[current] || "from-cyan-400/70 via-amber-400/60 to-emerald-400/60";

  return (
    <Card
      padding="none"
      className="group hyperion-card relative overflow-hidden border border-border/70 hover:border-cyan-500/40 transition-all"
    >
      <div className={`h-0.5 w-full bg-gradient-to-r ${topStrip}`} />
      <div className="p-4 flex min-w-0 flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="size-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-amber-500/10 border border-cyan-500/25 flex flex-col items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-cyan-400 text-[18px]">hub</span>
            <span className="text-[9px] font-mono text-text-muted leading-none mt-0.5">{combo.models.length}h</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <code
                onClick={(e) => { e.stopPropagation(); onCopy(copyText, `combo-${combo.id}`); }}
                className="inline-flex items-center gap-1.5 cursor-pointer truncate rounded-lg bg-black/5 dark:bg-white/[0.04] border border-border/60 px-2.5 py-0.5 font-mono text-sm font-semibold text-text-main hover:border-cyan-500/40 hover:text-cyan-400 transition-colors"
                title={`Click to copy combo name (${copyText})`}
              >
                <span>{combo.name}</span>
                {copied === `combo-${combo.id}` && (
                  <span className="text-[10px] font-sans font-medium text-emerald-400">Copied</span>
                )}
              </code>
              {maxContext > 0 && (
                <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                  maxContext >= 1000000
                    ? "bg-purple-500/15 text-purple-400 border border-purple-500/30 font-semibold"
                    : maxContext >= 200000
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : "bg-sidebar text-text-muted border border-border/60"
                }`}>
                  {maxContext >= 1000000 ? `${(maxContext / 1000000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(maxContext / 1000)}k`}
                </span>
              )}
              <span className="rounded-md bg-white/[0.03] border border-border/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                {combo.models.length} {combo.models.length === 1 ? "node" : "hops"}
              </span>
            </div>

            {/* Visual Routing Pipeline Chain */}
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No pipeline hops configured</span>
              ) : (
                combo.models.slice(0, 3).map((model, index) => (
                  <div key={index} className="inline-flex items-center gap-1.5 min-w-0">
                    {index > 0 && (
                      <span className="text-[11px] font-mono text-cyan-400/70 select-none">→</span>
                    )}
                    <code className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-black/[0.03] dark:bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-text-main">
                      <span className="inline-flex size-4 items-center justify-center rounded bg-cyan-500/15 text-[9px] font-bold text-cyan-400">
                        {index + 1}
                      </span>
                      <span className="truncate max-w-[220px]">{model}</span>
                      <CapacityBadges caps={modelCaps[model]} />
                    </code>
                  </div>
                ))
              )}
              {combo.models.length > 3 && (
                <span className="inline-flex items-center rounded-lg border border-dashed border-border/60 px-2 py-1 font-mono text-[10px] text-text-muted">
                  +{combo.models.length - 3} more hops
                </span>
              )}
            </div>

            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-fuchsia-400">Fusion Judge</span>
                <button
                  onClick={() => setShowJudgeSelect(true)}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-dashed border-fuchsia-400/40 bg-fuchsia-500/5 px-2 py-0.5 font-mono text-[11px] text-fuchsia-300 hover:border-fuchsia-400 hover:bg-fuchsia-500/10 transition-colors"
                  title="Pick the model that fuses panel answers"
                >
                  <span className="material-symbols-outlined text-[13px]">gavel</span>
                  <span className="truncate">{judge || `Auto — ${combo.models[0] || "first model"}`}</span>
                </button>
                {judge && (
                  <button
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="Reset judge to Auto"
                  >
                    <span className="material-symbols-outlined text-[13px]">close</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Actions Capsule */}
        <div className="flex w-full flex-col gap-2 lg:w-auto lg:flex-row lg:items-center lg:gap-3 lg:shrink-0">
          <div className="flex items-center gap-1.5 w-full lg:w-[225px]">
            <div className="flex-1 min-w-0">
              <Select
                options={STRATEGY_OPTIONS}
                value={current}
                onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
                selectClassName="py-1.5 text-xs"
              />
            </div>
            {onOpenStrategyHelp && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenStrategyHelp(current, combo.name);
                }}
                className="size-8 rounded-lg text-text-muted hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors flex items-center justify-center shrink-0 border border-border/60 hover:border-cyan-500/30"
                title="Strategy Guide & Details"
                aria-label="Strategy Guide"
              >
                <span className="material-symbols-outlined text-[16px]">help</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1 rounded-xl border border-border/60 bg-black/[0.02] dark:bg-white/[0.02] p-1 lg:flex">
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(copyText, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded-lg px-2.5 py-1 text-text-muted transition-colors hover:bg-cyan-500/10 hover:text-cyan-400"
              title={`Copy combo name (${copyText})`}
            >
              <span className="material-symbols-outlined text-[17px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">Copy</span>
            </button>
            <button
              onClick={onEdit}
              className="flex flex-col items-center rounded-lg px-2.5 py-1 text-text-muted transition-colors hover:bg-amber-500/10 hover:text-amber-400"
              title="Edit"
            >
              <span className="material-symbols-outlined text-[17px]">edit</span>
              <span className="text-[10px] leading-tight">Edit</span>
            </button>
            <button
              onClick={onDelete}
              className="flex flex-col items-center rounded-lg px-2.5 py-1 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
              title="Delete"
            >
              <span className="material-symbols-outlined text-[17px]">delete</span>
              <span className="text-[10px] leading-tight">Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; lazy mounted) */}
      {showJudgeSelect && (
        <ModelSelectModal
          isOpen={showJudgeSelect}
          onClose={() => setShowJudgeSelect(false)}
          onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
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
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, initialName }) {
  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || initialName || "");
  const [models, setModels] = useState(combo?.models || []);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
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

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (isOpen) fetchModalData();
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
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
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
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
      >
        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Only letters, numbers, -, _ and . allowed
            </p>
          </div>

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Models</label>

            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
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

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal - Lazy mounted */}
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
          addedModelValues={models}
          closeOnSelect={false}
        />
      )}
    </>
  );
}
