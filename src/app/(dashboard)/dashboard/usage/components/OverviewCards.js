"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  const cachedTokens = stats.totalCachedTokens || 0;
  const totalIn = stats.totalPromptTokens || 0;
  const cacheHitPct = totalIn > 0 ? Math.min(100, Math.round((cachedTokens / totalIn) * 100)) : 0;

  const cards = [
    {
      label: "Total Requests",
      value: fmt(stats.totalRequests),
      sub: stats.activeRequests?.length ? `${stats.activeRequests.length} in-flight` : "Completed calls",
      accent: "from-cyan-400/80 to-sky-400/40",
      valueColor: "text-text-main",
      icon: "bolt",
      iconCls: "text-cyan-400 bg-cyan-500/10 border-cyan-500/25",
    },
    {
      label: "Input Tokens",
      value: fmt(stats.totalPromptTokens),
      sub: cachedTokens > 0 ? `${fmt(cachedTokens)} cached (${cacheHitPct}%)` : "Prompt volume",
      accent: "from-amber-400/80 to-orange-400/40",
      valueColor: "text-amber-400",
      icon: "input",
      iconCls: "text-amber-400 bg-amber-500/10 border-amber-500/25",
    },
    {
      label: "Output Tokens",
      value: fmt(stats.totalCompletionTokens),
      sub: "Generated completions",
      accent: "from-emerald-400/80 to-teal-400/40",
      valueColor: "text-emerald-400",
      icon: "output",
      iconCls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
    },
    {
      label: "Est. Cost",
      value: `~${fmtCost(stats.totalCost)}`,
      sub: "Estimated, not actual billing",
      accent: "from-violet-400/80 to-fuchsia-400/40",
      valueColor: "text-violet-400",
      icon: "payments",
      iconCls: "text-violet-400 bg-violet-500/10 border-violet-500/25",
    },
  ];

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
      {cards.map((c) => (
        <Card
          key={c.label}
          padding="none"
          className="hyperion-card relative overflow-hidden border border-border/70"
        >
          <div className={`h-0.5 w-full bg-gradient-to-r ${c.accent}`} />
          <div className="p-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-mono uppercase tracking-wider text-text-muted">{c.label}</div>
              <div className={`mt-1.5 truncate font-mono text-2xl font-bold tabular-nums ${c.valueColor}`}>
                {c.value}
              </div>
              <div className="mt-1 truncate text-[11px] text-text-muted">{c.sub}</div>
            </div>
            <div className={`size-9 rounded-xl border flex items-center justify-center shrink-0 ${c.iconCls}`}>
              <span className="material-symbols-outlined text-[18px]">{c.icon}</span>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
