"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, StrategyHelpModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelContextWindows, resolveContextWindow } from "@/shared/hooks/useModelContextWindows";
import { withClaudeCodeSuffix } from "@/shared/utils/claudeCodeModelId";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

import AutoComboCatalog from "./AutoComboCatalog.jsx";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Template being snapshotted into the create modal (from AutoComboCatalog)
  const [snapshotTemplate, setSnapshotTemplate] = useState(null);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [modelCaps, setModelCaps] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();
  const { contextByFullModel } = useModelContextWindows();

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
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
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
      // Prune to keep settings clean: default fallback with no extras = no entry.
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
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

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const handleSnapshotTemplate = (tpl) => {
    setShowCreateModal(true);
    setSnapshotTemplate({
      name: tpl.name,
      models: [], // virtual combos have no static members; the API resolves them at request time
      strategy: tpl.strategy,
    });
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

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            Group models under one name, then choose a load balancing & failover strategy per combo:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-text-muted dark:bg-white/5">
              <span>🥇 Fallback (Order)</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-text-muted dark:bg-white/5">
              <span>🔄 Round Robin</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-text-muted dark:bg-white/5">
              <span>🎯 Cache-Optimized</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-text-muted dark:bg-white/5">
              <span>⚡ P2C</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-2 py-0.5 text-text-muted dark:bg-white/5">
              <span>🧬 Fusion Panel</span>
            </span>
            <button
              onClick={() => handleOpenStrategyHelp(null, null)}
              className="text-primary hover:underline font-medium inline-flex items-center gap-0.5"
            >
              <span>View all 10 strategies &rarr;</span>
            </button>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto shrink-0">
          <Button
            variant="secondary"
            icon="help"
            onClick={() => handleOpenStrategyHelp(null, null)}
            className="w-full sm:w-auto whitespace-nowrap"
            title="Load Balancing & Failover Strategy Guide"
          >
            Strategy Guide
          </Button>
          <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto whitespace-nowrap">
            Create Combo
          </Button>
        </div>
      </div>

      {/* Zero-config auto/* templates (OmniRoute parity) — call directly without saving */}
      <AutoComboCatalog onDuplicate={handleSnapshotTemplate} onCopy={copy} copiedId={copied} />

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">No combos yet</p>
            <p className="text-sm text-text-muted mb-4">Create model combos with fallback support</p>
            <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
              Create Combo
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {combos.map((combo) => (
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
              onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
              onOpenStrategyHelp={handleOpenStrategyHelp}
            />
          ))}
        </div>
      )}

      {/* Create Modal - Use key to force remount and reset state */}
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

      {/* Edit Modal - Use key to force remount and reset state */}
      <ComboFormModal
        key={editingCombo?.id || "new"}
        isOpen={!!editingCombo}
        combo={editingCombo}
        onClose={() => setEditingCombo(null)}
        onSave={(data) => handleUpdate(editingCombo.id, data)}
        activeProviders={activeProviders}
      />

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

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Priority Fallback — try in order 🥇" },
  { value: "round-robin", label: "Round Robin — cycle evenly 🔄" },
  { value: "cache-optimized", label: "Cache-Optimized — pin prompt prefix for 90% cache hits 🎯" },
  { value: "p2c", label: "P2C — Power-of-Two-Choices latency minimization ⚡" },
  { value: "reset-aware", label: "Reset-Aware — prioritize expiring quota windows 📊" },
  { value: "cost-optimized", label: "Cost-Optimized — lowest token cost first 💰" },
  { value: "headroom", label: "Headroom — highest remaining quota first 🔋" },
  { value: "least-used", label: "Least-Used — lowest active load ⚖️" },
  { value: "random", label: "Random — uniform load balancing 🎲" },
  { value: "fusion", label: "Fusion — fan-out panel + AI Judge synthesis 🧬" },
];

function ComboCard({ combo, modelCaps = {}, contextByFullModel = {}, activeProviders = [], modelAliases = {}, copied, onCopy, onEdit, onDelete, strategy = {}, onSetStrategy, onOpenStrategyHelp }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const current = strategy.fallbackStrategy || "fallback";
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

  return (
    <Card padding="sm" className="group">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <code
                onClick={(e) => { e.stopPropagation(); onCopy(copyText, `combo-${combo.id}`); }}
                className="block cursor-pointer truncate font-mono text-sm font-medium hover:text-primary transition-colors"
                title={`Click to copy combo name (${copyText})`}
              >
                {combo.name}
              </code>
              {maxContext > 0 && (
                <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                  maxContext >= 1000000
                    ? "bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 font-semibold"
                    : maxContext >= 200000
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                    : "bg-sidebar text-text-muted border border-border/60"
                }`}>
                  {maxContext >= 1000000 ? `${(maxContext / 1000000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(maxContext / 1000)}k`}
                </span>
              )}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No models</span>
              ) : (
                combo.models.slice(0, 3).map((model, index) => (
                  <code key={index} className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-text-muted dark:bg-white/5">
                    <span>{model}</span>
                    <CapacityBadges caps={modelCaps[model]} />
                  </code>
                ))
              )}
              {combo.models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{combo.models.length - 3} more</span>
              )}
            </div>
            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-text-muted">Judge</span>
                <button
                  onClick={() => setShowJudgeSelect(true)}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
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

        {/* Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          {/* Strategy selector with Help icon */}
          <div className="flex items-center gap-1.5 w-full sm:w-[225px]">
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
                className="size-7 rounded-lg text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center justify-center shrink-0 border border-transparent hover:border-border/60"
                title="Strategy Guide & Details"
                aria-label="Strategy Guide"
              >
                <span className="material-symbols-outlined text-[16px]">help</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1 sm:flex">
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(copyText, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title={`Copy combo name (${copyText})`}
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">Copy</span>
            </button>
            <button
              onClick={onEdit}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Edit"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              <span className="text-[10px] leading-tight">Edit</span>
            </button>
            <button
              onClick={onDelete}
              className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
              title="Delete"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              <span className="text-[10px] leading-tight">Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; combo members make natural judges too) */}
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

      {/* Model Select Modal */}
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
    </>
  );
}
