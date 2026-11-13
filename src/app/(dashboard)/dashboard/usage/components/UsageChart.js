"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { Segmented } from "antd";
import {
  BarChart,
  Bar,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const fmtTokens = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

export default function UsageChart({ period = "7d", chartData: chartDataProp = null }) {
  const [fetchedData, setFetchedData] = useState([]);
  const [loading, setLoading] = useState(!chartDataProp);
  const [viewMode, setViewMode] = useState("tokens");
  const [chartType, setChartType] = useState("bars");

  const fetchData = useCallback(async () => {
    if (chartDataProp) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/chart?period=${period}`);
      if (res.ok) {
        const json = await res.json();
        setFetchedData(Array.isArray(json) ? json : []);
      }
    } catch (e) {
      console.error("Failed to fetch chart data:", e);
    } finally {
      setLoading(false);
    }
  }, [period, chartDataProp]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const data = useMemo(
    () => (Array.isArray(chartDataProp) ? chartDataProp : fetchedData),
    [chartDataProp, fetchedData]
  );

  const metricKey = viewMode === "tokens" ? "tokens" : "cost";
  const hasData = data.some((d) => (d.tokens || 0) > 0 || (d.cost || 0) > 0);

  const peakIndex = useMemo(() => {
    let bestIdx = data.length - 1;
    let maxVal = -1;
    data.forEach((d, idx) => {
      const v = Number(d?.[metricKey]) || 0;
      if (v >= maxVal) {
        maxVal = v;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }, [data, metricKey]);

  const tooltipStyle = {
    backgroundColor: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-elevated)",
    fontSize: "12px",
    color: "var(--color-text-main)",
  };
  const tooltipLabelStyle = {
    color: "var(--color-text-muted)",
    fontWeight: 600,
    marginBottom: "2px",
  };
  const tooltipItemStyle = {
    color: "var(--color-text-main)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    padding: 0,
  };

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-bg-alt">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-text-main m-0">
            Usage Overview
          </h2>
          <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
            {period.toUpperCase()}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Segmented
            size="small"
            value={chartType}
            onChange={setChartType}
            options={[
              { label: "Bars", value: "bars" },
              { label: "Trend", value: "area" },
            ]}
          />
          <Segmented
            size="small"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { label: "Tokens", value: "tokens" },
              { label: "Cost", value: "cost" },
            ]}
          />
        </div>
      </div>

      <div className="p-4">
        {loading && !chartDataProp ? (
          <div className="h-[220px] flex items-center justify-center text-xs text-text-muted">
            Loading usage series...
          </div>
        ) : !hasData ? (
          <div className="h-[220px] flex items-center justify-center text-xs text-text-muted">
            No telemetry recorded for {period.toUpperCase()}.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            {chartType === "bars" ? (
              <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--color-border)" }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
                  width={56}
                />
                <Tooltip
                  cursor={{ fill: "var(--color-surface-2)", opacity: 0.55 }}
                  contentStyle={tooltipStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  formatter={(value) =>
                    viewMode === "tokens" ? [fmtTokens(value), "Tokens"] : [fmtCost(value), "Cost"]
                  }
                />
                <Bar
                  dataKey={metricKey}
                  fill="var(--color-text-main)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                >
                  {data.map((entry, idx) => (
                    <Cell
                      key={`bar-${entry.label || idx}`}
                      fill={
                        idx === peakIndex
                          ? "var(--color-text-main)"
                          : "var(--color-border-strong)"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            ) : (
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="monoUsageArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-text-main)" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="var(--color-text-main)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--color-border)" }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
                  width={56}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipItemStyle}
                  formatter={(value) =>
                    viewMode === "tokens" ? [fmtTokens(value), "Tokens"] : [fmtCost(value), "Cost"]
                  }
                />
                <Area
                  type="monotone"
                  dataKey={metricKey}
                  stroke="var(--color-text-main)"
                  strokeWidth={1.85}
                  fill="url(#monoUsageArea)"
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--color-text-main)", strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
  chartData: PropTypes.array,
};
