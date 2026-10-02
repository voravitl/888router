"use client";

import { useState, useMemo } from "react";
import Modal from "./Modal";
import Badge from "./Badge";

import { STRATEGY_DETAILS, ACTIVE_STRATEGY_COUNT } from "../constants/comboStrategies.js";

// Re-exported so existing importers (src/shared/components/index.js) keep working.
export { STRATEGY_DETAILS };
export { ACTIVE_STRATEGY_COUNT };

export function StrategyHelpModal({ isOpen, onClose, selectedStrategy, onSelectStrategy }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");

  const categories = [
    { id: "all", label: "All Strategies", count: STRATEGY_DETAILS.length },
    { id: "reliability", label: "Reliability & Failover", count: STRATEGY_DETAILS.filter(s => s.category === "reliability").length },
    { id: "performance", label: "Performance & Caching", count: STRATEGY_DETAILS.filter(s => s.category === "performance").length },
    { id: "cost", label: "Cost & Quota", count: STRATEGY_DETAILS.filter(s => s.category === "cost").length },
    { id: "advanced", label: "Advanced AI", count: STRATEGY_DETAILS.filter(s => s.category === "advanced").length }
  ];

  const filteredStrategies = useMemo(() => {
    return STRATEGY_DETAILS.filter(item => {
      const matchesCategory = activeCategory === "all" || item.category === activeCategory;
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        item.name.toLowerCase().includes(query) ||
        item.tagline.toLowerCase().includes(query) ||
        item.summary.toLowerCase().includes(query) ||
        item.bestFor.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Load Balancing & Failover Strategies Guide"
      size="xl"
    >
      <div className="flex flex-col gap-4">
        {/* Header Intro */}
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 text-xs text-text-muted">
          <div className="flex items-center gap-2 font-medium text-primary text-sm mb-1">
            <span className="material-symbols-outlined text-[18px]">hub</span>
            <span>How Combos Manage Routing & Fault Tolerance</span>
          </div>
          <p className="leading-relaxed">
            Combos allow you to group multiple models under a single identifier. Choose the strategy that best matches your workflow requirements—whether you need zero-downtime reliability, maximum prompt cache hits, or multi-model AI synthesis.
          </p>
        </div>

        {/* Search & Category Filter Controls */}
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          {/* Categories Tab Bar */}
          <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {categories.map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                  activeCategory === cat.id
                    ? "bg-primary text-white shadow-sm"
                    : "bg-sidebar hover:bg-black/5 dark:hover:bg-white/5 text-text-muted border border-border/50"
                }`}
              >
                <span>{cat.label}</span>
                <span className={`text-[10px] rounded-full px-1.5 py-0.2 ${
                  activeCategory === cat.id ? "bg-white/20 text-white" : "bg-black/10 dark:bg-white/10 text-text-muted"
                }`}>
                  {cat.count}
                </span>
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative w-full sm:w-60">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search strategy..."
              className="w-full rounded-lg border border-border/70 bg-sidebar pl-8 pr-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>
        </div>

        {/* Strategy Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[58vh] overflow-y-auto pr-1">
          {filteredStrategies.length === 0 ? (
            <div className="col-span-full py-10 text-center text-text-muted">
              <span className="material-symbols-outlined text-4xl mb-2 text-text-muted/40">search_off</span>
              <p className="text-sm">No strategies match &ldquo;{searchQuery}&rdquo;</p>
            </div>
          ) : (
            filteredStrategies.map((item) => {
              const isSelected = selectedStrategy === item.id;
              return (
                <div
                  key={item.id}
                  className={`flex flex-col justify-between rounded-xl border p-3.5 transition-all ${
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary shadow-sm"
                      : "border-border/70 bg-card hover:border-primary/40 hover:bg-black/[0.01] dark:hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex flex-col gap-2">
                    {/* Top Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xl" role="img" aria-label={item.name}>{item.icon}</span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h4 className="font-semibold text-sm text-text">{item.name}</h4>
                            {isSelected && (
                              <span className="inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.2 text-[10px] font-medium text-primary border border-primary/20">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-text-muted leading-tight">{item.tagline}</p>
                        </div>
                      </div>
                      <Badge variant={item.planned ? "default" : item.badgeVariant} size="sm">
                        {item.planned ? (item.badgeLabel || "Planned") : item.categoryLabel}
                      </Badge>
                    </div>

                    {/* Summary */}
                    <p className="text-xs text-text-muted leading-relaxed mt-1">
                      {item.summary}
                    </p>

                    {/* Details Box */}
                    <div className="rounded-lg bg-black/5 dark:bg-white/5 p-2.5 flex flex-col gap-1.5 text-[11px] mt-1 border border-border/40">
                      <div>
                        <span className="font-medium text-text">🎯 Best For: </span>
                        <span className="text-text-muted">{item.bestFor}</span>
                      </div>
                      <div>
                        <span className="font-medium text-text">⚙️ Mechanism: </span>
                        <span className="text-text-muted">{item.howItWorks}</span>
                      </div>
                      {item.tips && (
                        <div className="pt-1 border-t border-border/30 text-[10px] text-primary/90 flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px] shrink-0">tips_and_updates</span>
                          <span>{item.tips}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Optional Select Button if handler provided */}
                  {onSelectStrategy && (
                    <div className="mt-3 pt-2.5 border-t border-border/40 flex justify-end">
                      <button
                        onClick={() => {
                          onSelectStrategy(item.id);
                          onClose();
                        }}
                        disabled={isSelected || item.planned}
                        className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                          isSelected
                            ? "bg-primary/10 text-primary cursor-default"
                            : item.planned
                              ? "bg-sidebar text-text-muted cursor-not-allowed border border-border/60"
                              : "bg-primary text-white hover:bg-primary/90 shadow-sm"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {isSelected ? "check" : item.planned ? "schedule" : "check_circle"}
                        </span>
                        <span>{isSelected ? "Selected" : item.planned ? "Planned" : `Use ${item.name}`}</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between border-t border-border/60 pt-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px] text-primary">verified</span>
            <span>
              {ACTIVE_STRATEGY_COUNT} strategies active and fully supported &middot;{" "}
              {STRATEGY_DETAILS.length - ACTIVE_STRATEGY_COUNT} planned (not yet implemented)
            </span>
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-sidebar border border-border/60 px-3 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
