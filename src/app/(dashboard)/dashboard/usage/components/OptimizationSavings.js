"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtPct = (n) => `${(n || 0).toFixed(1)}%`;
const fmtBytes = (n) => {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

function SavingsCard({
  title,
  icon,
  stats,
  beforeLabel = "Before",
  afterLabel = "After",
  savedLabel = "Saved",
  children,
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-text-main">{icon}</span>
        <span className="text-text-main text-xs font-semibold">{title}</span>
      </div>
      {stats && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-text-muted">{beforeLabel}</span>
            <span className="block font-mono font-semibold text-text-main">{stats.before}</span>
          </div>
          <div>
            <span className="text-text-muted">{afterLabel}</span>
            <span className="block font-mono font-semibold text-text-main">{stats.after}</span>
          </div>
          <div className="col-span-2">
            <span className="text-text-muted">{savedLabel}</span>
            <span className={`block font-mono font-semibold ${stats.savedPctNum > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-text-muted"}`}>
              {stats.saved} ({stats.savedPct})
            </span>
          </div>
        </div>
      )}
      {children}
    </Card>
  );
}

export default function OptimizationSavings({ period = "7d" }) {
  const [state, setState] = useState({ data: null, loadedPeriod: null });
  const loading = state.loadedPeriod !== period;
  const data = state.data;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/usage/token-save-summary?period=${period}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!controller.signal.aborted) {
          setState({ data: d, loadedPeriod: period });
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError" && !controller.signal.aborted) {
          setState({ data: null, loadedPeriod: period });
        }
      });
    return () => controller.abort();
  }, [period]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-text-muted">
        <span className="material-symbols-outlined text-[24px] animate-spin">progress_activity</span>
      </div>
    );
  }

  if (!data) {
    return <div className="text-text-muted text-sm py-4">No optimization data available.</div>;
  }

  const { rtk, promptCache } = data || {};

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-text-main">speed</span>
        <span className="text-sm font-semibold text-text-main">Token & Bandwidth Savings</span>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Upstream prompt cache — #1 real-traffic saver reflected in provider billing */}
        <SavingsCard
          title="Prompt Cache"
          icon="database"
          beforeLabel="Prompt Tokens"
          afterLabel="Cached"
          savedLabel="Reused"
          stats={{
            before: fmt(promptCache?.promptTokens),
            after: fmt(promptCache?.cachedTokens),
            saved: `${fmt(promptCache?.cachedTokens)} tok`,
            savedPct: fmtPct(promptCache?.pctSaved),
            savedPctNum: promptCache?.pctSaved,
          }}
        >
          <div className="text-[10px] text-text-muted">
            {fmt(promptCache?.requestsWithCache)}/{fmt(promptCache?.requests)} requests reused a cached prefix
          </div>
        </SavingsCard>

        {/* RTK: Tool Output Compression */}
        <SavingsCard
          title="RTK Compression"
          icon="compress"
          stats={{
            before: fmtBytes(rtk?.bytesBefore),
            after: fmtBytes(rtk?.bytesAfter),
            saved: fmtBytes(rtk?.bytesSaved),
            savedPct: fmtPct(rtk?.pctSaved),
            savedPctNum: rtk?.pctSaved,
          }}
        >
          <div className="text-[10px] text-text-muted">
            {fmt(rtk?.requestsWithSavings)}/{fmt(rtk?.requestsWithStats)} requests saved
          </div>
          {rtk?.topFilters?.length > 0 && (
            <div className="mt-1">
              <div className="text-[10px] text-text-muted mb-1">Top patterns:</div>
              <div className="flex flex-wrap gap-1">
                {rtk.topFilters.slice(0, 4).map((f) => (
                  <span key={f.name} className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] font-mono text-text-muted">
                    {f.name}
                    <span className="text-info font-bold">{fmt(f.count)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </SavingsCard>
      </div>

      {/* Summary bar */}
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>
            <span className="font-mono font-semibold text-text-main">{fmtBytes(rtk?.bytesSaved)}</span> RTK bytes saved
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <span className="font-mono font-semibold text-text-main">{fmt(promptCache?.cachedTokens)}</span> prompt tokens cached ({fmtPct(promptCache?.pctSaved)})
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Scanned <span className="font-mono font-semibold text-text-main">{fmt(data?.period?.scanned)}</span> requests
            {data?.period?.truncated && " (truncated)"}
          </span>
        </div>
      </Card>
    </div>
  );
}
