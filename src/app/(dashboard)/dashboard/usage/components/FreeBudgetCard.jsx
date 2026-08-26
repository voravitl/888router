"use client";

import { useState, useEffect, useMemo } from "react";
import { Card } from "@/shared/components";

function fmtTokens(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (n >= 1e6) return Math.round(n / 1e6) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

export default function FreeBudgetCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [excludeAvoid, setExcludeAvoid] = useState(false);
  const [copiedExpr, setCopiedExpr] = useState(null);

  const handleCopy = (text) => {
    if (!navigator?.clipboard) return;
    navigator.clipboard.writeText(text);
    setCopiedExpr(text);
    setTimeout(() => setCopiedExpr(null), 2000);
  };

  useEffect(() => {
    let mounted = true;
    async function loadSummary() {
      try {
        setLoading(true);
        const res = await fetch(`/api/free-tier/summary?excludeTosAvoid=${excludeAvoid ? "1" : "0"}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (mounted) setData(json);
      } catch (err) {
        console.error("Failed to load free tier summary:", err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadSummary();
    return () => { mounted = false; };
  }, [excludeAvoid]);

  const providersList = useMemo(() => {
    if (!data?.perModel) return [];
    const set = new Set(data.perModel.map(m => m.provider));
    return Array.from(set).sort();
  }, [data]);

  const filteredModels = useMemo(() => {
    if (!data?.perModel) return [];
    const q = search.trim().toLowerCase();
    return data.perModel.filter(m => {
      if (selectedProvider !== "all" && m.provider !== selectedProvider) return false;
      if (!q) return true;
      return (
        m.displayName?.toLowerCase().includes(q) ||
        m.modelId?.toLowerCase().includes(q) ||
        m.provider?.toLowerCase().includes(q)
      );
    });
  }, [data, search, selectedProvider]);

  return (
    <div className="flex flex-col gap-6">
      {/* Header & KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col p-4">
          <span className="text-xs font-medium text-text-muted">Steady Free Quota</span>
          <span className="mt-1 text-2xl font-bold text-emerald-500">
            {loading ? "..." : `~${fmtTokens(data?.steadyRecurringTokens)} / mo`}
          </span>
          <span className="mt-1 text-[11px] text-text-subtle">Pool-deduplicated recurring free tier</span>
        </Card>

        <Card className="flex flex-col p-4">
          <span className="text-xs font-medium text-text-muted">Uncapped Free Providers</span>
          <span className="mt-1 text-2xl font-bold text-brand-500">
            {loading ? "..." : `${data?.uncappedProviders?.length || 0} Providers`}
          </span>
          <span className="mt-1 text-[11px] text-text-subtle">Rate-limited, permanent $0 inference</span>
        </Card>

        <Card className="flex flex-col p-4">
          <span className="text-xs font-medium text-text-muted">Total Free Models</span>
          <span className="mt-1 text-2xl font-bold text-text-main">
            {loading ? "..." : `${data?.modelCount || 0} Models`}
          </span>
          <span className="mt-1 text-[11px] text-text-subtle">Across all documented free tiers</span>
        </Card>

        <Card className="flex flex-col p-4">
          <span className="text-xs font-medium text-text-muted">Independent Free Pools</span>
          <span className="mt-1 text-2xl font-bold text-sky-500">
            {loading ? "..." : `${data?.poolCount || 0} Quota Pools`}
          </span>
          <span className="mt-1 text-[11px] text-text-subtle">Distinct upstream quota buckets</span>
        </Card>
      </div>

      {/* Filter controls */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 items-center gap-2">
            <input
              type="text"
              placeholder="Search free models by name, ID or provider..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full max-w-md rounded-lg border border-border bg-bg-alt px-3 py-1.5 text-xs text-text-main placeholder-text-muted focus:border-brand-500 focus:outline-none"
            />
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="rounded-lg border border-border bg-bg-alt px-3 py-1.5 text-xs text-text-main focus:border-brand-500 focus:outline-none"
            >
              <option value="all">All Providers ({providersList.length})</option>
              {providersList.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={excludeAvoid}
              onChange={(e) => setExcludeAvoid(e.target.checked)}
              className="rounded border-border text-brand-500 focus:ring-0"
            />
            <span>Exclude intrusive TOS (avoid)</span>
          </label>
        </div>

        {/* Models Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="pb-2 font-medium">Provider</th>
                <th className="pb-2 font-medium">Model / Display Name</th>
                <th className="pb-2 font-medium">Allowance</th>
                <th className="pb-2 font-medium">Regime</th>
                <th className="pb-2 font-medium">Guarantees & TOS</th>
                <th className="pb-2 font-medium text-right pr-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filteredModels.slice(0, 100).map((m, idx) => {
                const expr = `${m.provider}/${m.modelId}`;
                const isCopied = copiedExpr === expr;
                return (
                  <tr key={`${m.provider}-${m.modelId}-${idx}`} className="hover:bg-bg-alt/50 transition-colors">
                    <td className="py-2.5 pr-3 font-semibold text-text-main">
                      <span className="inline-block rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
                        {m.provider}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium text-text-main">{m.displayName || m.modelId}</div>
                      <div className="font-mono text-[10px] text-text-muted">{m.modelId}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {m.monthlyTokens > 0 ? (
                        <span className="font-semibold text-emerald-500">~{fmtTokens(m.monthlyTokens)}/mo</span>
                      ) : m.creditTokens > 0 ? (
                        <span className="font-semibold text-amber-500">${fmtTokens(m.creditTokens)} credit</span>
                      ) : (
                        <span className="text-text-muted font-mono">Uncapped / Keyless</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-medium text-brand-500">
                        {m.freeType}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {m.hardStopGuaranteed && (
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            🛡️ Hard Stop ($0 Guarantee)
                          </span>
                        )}
                        {m.trainsOnPrompts && (
                          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-500">
                            ⚠️ Trains on Prompts
                          </span>
                        )}
                        {m.tos === "avoid" && (
                          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-500">
                            🚫 Avoid TOS
                          </span>
                        )}
                        {m.tos === "caution" && (
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            ⚠️ Caution TOS
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleCopy(expr)}
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-muted hover:border-brand-500 hover:text-brand-500 transition-colors"
                          title={`Copy ${expr} for Claude Code, Cursor, Cline`}
                        >
                          <span className="material-symbols-outlined text-[13px]">
                            {isCopied ? "check" : "content_copy"}
                          </span>
                          <span>{isCopied ? "Copied!" : "Copy"}</span>
                        </button>
                        <a
                          href={`/dashboard/providers/new?provider=${encodeURIComponent(m.provider)}`}
                          className="inline-flex items-center gap-1 rounded bg-brand-500/10 px-2 py-1 text-[11px] font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-500/20 transition-colors"
                          title={`Connect ${m.provider}`}
                        >
                          <span className="material-symbols-outlined text-[13px]">add_link</span>
                          <span>Connect</span>
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {filteredModels.length === 0 && (
            <div className="py-8 text-center text-xs text-text-muted">
              No free models match your filter criteria.
            </div>
          )}
          {filteredModels.length > 100 && (
            <div className="py-2 text-center text-[11px] text-text-subtle">
              Showing top 100 of {filteredModels.length} matching free models. Refine search for specific models.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
