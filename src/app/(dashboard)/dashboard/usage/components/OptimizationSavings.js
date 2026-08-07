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

function SavingsCard({ title, icon, color, stats, children }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={`material-symbols-outlined text-[20px] ${color}`}>{icon}</span>
        <span className="text-text-muted text-sm uppercase font-semibold">{title}</span>
      </div>
      {stats && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-text-muted">Before</span>
            <span className="block font-mono font-bold">{stats.before}</span>
          </div>
          <div>
            <span className="text-text-muted">After</span>
            <span className="block font-mono font-bold">{stats.after}</span>
          </div>
          <div className="col-span-2">
            <span className="text-text-muted">Saved</span>
            <span className={`block font-mono font-bold ${stats.savedPctNum > 0 ? "text-success" : "text-text-muted"}`}>
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/usage/token-save-summary?period=${period}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
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

  const { rtk, pruner, headroom, cache } = data || {};

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[20px] text-primary">speed</span>
        <span className="text-sm font-semibold uppercase tracking-wide text-text-muted">Token & Bandwidth Savings</span>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* RTK: Tool Output Compression */}
        <SavingsCard
          title="RTK Compression"
          icon="compress"
          color="text-info"
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

        {/* Pruner: AST Soft-Pruner */}
        <SavingsCard
          title="AST Pruner"
          icon="account_tree"
          color="text-warning"
          stats={{
            before: fmt(pruner?.tokensBefore),
            after: fmt(pruner?.tokensAfter),
            saved: fmt(pruner?.tokensSaved),
            savedPct: fmtPct(pruner?.pctSaved),
            savedPctNum: pruner?.pctSaved,
          }}
        >
          <div className="text-[10px] text-text-muted">
            {fmt(pruner?.requestsWithSavings)}/{fmt(pruner?.requestsWithStats)} requests saved
            {pruner?.omittedMessages > 0 && ` · ${fmt(pruner?.omittedMessages)} msgs omitted`}
          </div>
        </SavingsCard>

        {/* Headroom: Upstream Proxy */}
        <SavingsCard
          title="Headroom Proxy"
          icon="router"
          color="text-primary"
          stats={{
            before: fmtBytes(headroom?.bytesBefore),
            after: fmtBytes(headroom?.bytesAfter),
            saved: fmtBytes(headroom?.bytesSaved),
            savedPct: fmtPct(headroom?.pctBytesSaved),
            savedPctNum: headroom?.pctBytesSaved,
          }}
        >
          <div className="text-[10px] text-text-muted">
            {fmt(headroom?.requestsWithSavings)}/{fmt(headroom?.requestsWithStats)} requests saved
          </div>
          {headroom?.topSkipReasonsRecent24h?.length > 0 && (
            <div className="mt-1">
              <div className="text-[10px] text-text-muted mb-1">Skip reasons (24h):</div>
              <div className="flex flex-wrap gap-1">
                {headroom.topSkipReasonsRecent24h.slice(0, 3).map((r) => (
                  <span key={r.reason} className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-text-muted">
                    {r.reason.length > 20 ? r.reason.slice(0, 20) + "…" : r.reason}
                    <span className="text-warning font-bold">{fmt(r.count)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </SavingsCard>

        {/* Response Cache */}
        <SavingsCard
          title="Response Cache"
          icon="cached"
          color="text-success"
          stats={{
            before: fmt(cache?.requests),
            after: fmt(cache?.hits),
            saved: `${fmtPct(cache?.hitRate)} hit rate`,
            savedPct: fmtPct(cache?.hitRate),
            savedPctNum: cache?.hitRate,
          }}
        >
          <div className="text-[10px] text-text-muted">
            {fmt(cache?.hits)} hits from {fmt(cache?.requests)} requests
          </div>
        </SavingsCard>
      </div>

      {/* Summary bar */}
      <Card className="px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
          <span className="text-text-muted">
            <span className="font-semibold text-info">{fmtBytes(rtk?.bytesSaved)}</span> saved by RTK
          </span>
          <span className="text-text-muted">
            <span className="font-semibold text-warning">{fmt(pruner?.tokensSaved)}</span> tokens pruned
          </span>
          <span className="text-text-muted">
            <span className="font-semibold text-primary">{fmtBytes(headroom?.bytesSaved)}</span> via Headroom
          </span>
          <span className="text-text-muted">
            Scanned <span className="font-semibold">{fmt(data?.period?.scanned)}</span> requests
            {data?.period?.truncated && " (truncated)"}
          </span>
        </div>
      </Card>
    </div>
  );
}
