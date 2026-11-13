"use client";

import { useMemo } from "react";
import PropTypes from "prop-types";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { cn } from "@/shared/utils/cn";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCompact = (n) => {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

function MiniSparkline({ data, dataKey, id }) {
  const safeData = useMemo(() => {
    if (Array.isArray(data) && data.length > 0) {
      return data.map((d, i) => ({ idx: i, val: Number(d?.[dataKey]) || 0 }));
    }
    return Array.from({ length: 8 }, (_, idx) => ({ idx, val: 0 }));
  }, [data, dataKey]);

  const gradId = `mono-spark-${id}`;

  return (
    <div className="h-[44px] w-full pt-1">
      <ResponsiveContainer width="100%" height={44}>
        <AreaChart data={safeData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-text-main)" stopOpacity={0.14} />
              <stop offset="100%" stopColor="var(--color-text-main)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="val"
            stroke="var(--color-text-main)"
            strokeWidth={1.6}
            fill={`url(#${gradId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

MiniSparkline.propTypes = {
  data: PropTypes.array,
  dataKey: PropTypes.string.isRequired,
  id: PropTypes.string.isRequired,
};

export default function OverviewCards({ stats, period = "7d", chartData = [] }) {
  const totalRequests = stats?.totalRequests || 0;
  const promptTokens = stats?.totalPromptTokens || 0;
  const cachedTokens = stats?.totalCachedTokens || 0;
  const completionTokens = stats?.totalCompletionTokens || 0;
  const totalTokens = promptTokens + completionTokens;
  const activeCount = Array.isArray(stats?.activeRequests)
    ? stats.activeRequests.reduce((acc, item) => acc + (item.count || 0), 0)
    : 0;
  const cacheHitPct =
    promptTokens > 0 ? Math.min(100, Math.round((cachedTokens / promptTokens) * 100)) : 0;

  const filledSegments =
    cacheHitPct > 0 ? Math.max(1, Math.min(12, Math.round((cacheHitPct / 100) * 12))) : 0;
  const minuteSeries = Array.isArray(stats?.last10Minutes) ? stats.last10Minutes : [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
      {/* 1. Requests + 10m live activity sparkline */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-medium text-text-muted">Total Requests</span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-main">
              <span
                className={cn(
                  "size-1.5 rounded-full inline-block",
                  activeCount > 0 ? "bg-[#a6c23f]" : "bg-text-subtle"
                )}
              />
              {activeCount} active
            </span>
          </div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums text-text-main">
            {fmt(totalRequests)}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 tabular-nums">
            Last 10m request cadence
          </div>
        </div>
        <MiniSparkline data={minuteSeries} dataKey="requests" id="requests" />
      </div>

      {/* 2. Token Volume + Period Token Sparkline */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-medium text-text-muted">Token Volume</span>
            <span className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted">
              {period.toUpperCase()}
            </span>
          </div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums text-text-main">
            {fmtCompact(totalTokens)}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 tabular-nums">
            In {fmtCompact(promptTokens)} · Out {fmtCompact(completionTokens)}
          </div>
        </div>
        <MiniSparkline data={chartData} dataKey="tokens" id="tokens" />
      </div>

      {/* 3. Prompt Cache Efficiency */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-medium text-text-muted">Cache Hit Rate</span>
            <span className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-main">
              {fmtCompact(cachedTokens)} cached
            </span>
          </div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums text-text-main">
            {cacheHitPct}%
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 tabular-nums">
            {cachedTokens > 0 ? `${fmt(cachedTokens)} prompt tokens reused` : "No cached prefix hits yet"}
          </div>
        </div>
        <div className="h-[44px] flex flex-col justify-end pt-2">
          <div className="grid grid-cols-12 gap-1" aria-label={`Cache hit rate ${cacheHitPct}%`}>
            {Array.from({ length: 12 }, (_, idx) => (
              <span
                key={idx}
                className={cn(
                  "h-2.5 rounded-sm transition-colors",
                  idx < filledSegments ? "bg-[#a6c23f]" : "bg-surface-2 border border-border-subtle"
                )}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 4. Estimated Cost + Cost Trend Sparkline */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-medium text-text-muted">Estimated Cost</span>
            <span className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted">
              {fmt(totalRequests)} calls
            </span>
          </div>
          <div className="text-2xl font-semibold tracking-tight tabular-nums text-text-main">
            {fmtCost(stats?.totalCost)}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 tabular-nums">
            Weighted by {period.toUpperCase()} token usage
          </div>
        </div>
        <MiniSparkline data={chartData} dataKey="cost" id="cost" />
      </div>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object,
  period: PropTypes.string,
  chartData: PropTypes.array,
};
