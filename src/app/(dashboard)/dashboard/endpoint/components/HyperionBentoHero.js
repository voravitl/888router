"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Segmented } from "antd";
import {
  ReloadOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import {
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/shared/utils/cn";

function formatCompactNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatLastActivity(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const THINKING_TIERS = {
  low: { alias: "gemini-4-hydrogen-low" },
  medium: { alias: "gemini-4-hydrogen-medium" },
  high: { alias: "gemini-4-hydrogen" },
  xhigh: { alias: "gemini-4-hydrogen-xhigh" },
};

const SDK_OPTIONS = [
  { label: "cURL", value: "curl" },
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Cursor", value: "cursor" },
  { label: "OpenCode", value: "opencode" },
  { label: "Hermes", value: "hermes" },
];

export default function HyperionBentoHero({
  apiKeyCount = 0,
  loadingKeys = false,
  baseUrl = "",
  sampleKey = "sk-888-your-key",
}) {
  const [sdkTab, setSdkTab] = useState("curl");
  const [copiedSdk, setCopiedSdk] = useState(false);
  const [period, setPeriod] = useState("7d");
  const [activityMode, setActivityMode] = useState("10m");
  const [chart24h, setChart24h] = useState([]);
  const [loading24h, setLoading24h] = useState(false);
  const [thinkingTier, setThinkingTier] = useState("xhigh");
  const [copiedModel, setCopiedModel] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [telemetry, setTelemetry] = useState({
    totalRequests: 0,
    totalTokens: 0,
    cachedTokens: 0,
    activeRequests: [],
    recentRequests: [],
    last10Minutes: [],
    lastActivityAt: null,
    byProvider: {},
    topModels: [],
    activeProvidersList: [],
    providersActive: 0,
    providersTotal: 0,
    comboCount: 0,
  });

  const fetchTelemetryData = useCallback(async (selectedPeriod) => {
    const [statsRes, providersRes, combosRes] = await Promise.all([
      fetch(`/api/usage/stats?period=${selectedPeriod}`).catch(() => null),
      fetch("/api/providers").catch(() => null),
      fetch("/api/combos").catch(() => null),
    ]);

    const statsData = statsRes?.ok ? await statsRes.json().catch(() => ({})) : {};
    const providersData = providersRes?.ok ? await providersRes.json().catch(() => ({})) : {};
    const combosData = combosRes?.ok ? await combosRes.json().catch(() => ({})) : {};

    const connections = Array.isArray(providersData?.connections)
      ? providersData.connections
      : [];
    const activeConns = connections.filter((c) => c.isActive !== false);
    const combos = Array.isArray(combosData?.combos) ? combosData.combos : [];

    const totalPrompt = Number(statsData?.totalPromptTokens) || 0;
    const totalCompletion = Number(statsData?.totalCompletionTokens) || 0;
    const cached = Number(statsData?.totalCachedTokens) || 0;

    const byModelEntries = Object.entries(statsData?.byModel || {})
      .map(([name, val]) => ({
        name,
        requests: Number(val?.requests) || 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 3);

    const providerCounts = {};
    for (const c of activeConns) {
      const key = c.provider || "unknown";
      providerCounts[key] = (providerCounts[key] || 0) + 1;
    }
    const activeProvidersList = Object.entries(providerCounts)
      .map(([provider, connCount]) => ({ provider, connCount }))
      .sort((a, b) => b.connCount - a.connCount)
      .slice(0, 4);

    return {
      totalRequests: Number(statsData?.totalRequests) || 0,
      totalTokens: totalPrompt + totalCompletion,
      cachedTokens: cached,
      activeRequests: Array.isArray(statsData?.activeRequests)
        ? statsData.activeRequests
        : [],
      recentRequests: Array.isArray(statsData?.recentRequests)
        ? statsData.recentRequests.slice(0, 4)
        : [],
      last10Minutes: Array.isArray(statsData?.last10Minutes)
        ? statsData.last10Minutes
        : [],
      lastActivityAt:
        statsData?.lastActivityAt ??
        statsData?.recentRequests?.[0]?.timestamp ??
        null,
      byProvider: statsData?.byProvider || {},
      topModels: byModelEntries,
      activeProvidersList,
      providersActive: activeConns.length,
      providersTotal: connections.length,
      comboCount: combos.length,
    };
  }, []);

  const fetch24hChartData = useCallback(async (signal) => {
    const res = await fetch("/api/usage/chart?period=24h", { signal });
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    const list = Array.isArray(rows) ? rows : [];
    return list.map((b) => ({
      label: b?.label || "",
      requests: Number(b?.requests) || 0,
      errors: Number(b?.errors) || 0,
      tokens: Number(b?.tokens) || 0,
    }));
  }, []);

  useEffect(() => {
    let active = true;
    fetchTelemetryData(period)
      .then((next) => {
        if (active) setTelemetry(next);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [period, fetchTelemetryData]);

  useEffect(() => {
    if (activityMode !== "24h") return;
    let active = true;
    const controller = new AbortController();
    fetch24hChartData(controller.signal)
      .then((rows) => {
        if (active) setChart24h(rows);
      })
      .catch((err) => {
        if (err?.name !== "AbortError" && active) setChart24h([]);
      })
      .finally(() => {
        if (active) setLoading24h(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activityMode, fetch24hChartData]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es;
    try {
      es = new EventSource("/api/usage/stream");
      es.onopen = () => setSseConnected(true);
      es.onmessage = (event) => {
        try {
          const live = JSON.parse(event.data);
          setTelemetry((prev) => ({
            ...prev,
            activeRequests: Array.isArray(live?.activeRequests)
              ? live.activeRequests
              : prev.activeRequests,
            recentRequests: Array.isArray(live?.recentRequests)
              ? live.recentRequests.slice(0, 4)
              : prev.recentRequests,
            last10Minutes: Array.isArray(live?.last10Minutes)
              ? live.last10Minutes
              : prev.last10Minutes,
            lastActivityAt:
              live && "lastActivityAt" in live
                ? (live.lastActivityAt ?? live?.recentRequests?.[0]?.timestamp ?? null)
                : (live?.recentRequests?.[0]?.timestamp ?? prev.lastActivityAt),
          }));
        } catch {
          // Ignore malformed keepalive events
        }
      };
      es.onerror = () => setSseConnected(false);
    } catch {
      // SSE unavailable; fallback interval handles refresh
    }
    return () => {
      if (es) es.close();
    };
  }, []);

  useEffect(() => {
    if (sseConnected) return;
    let active = true;
    const timer = setInterval(() => {
      fetchTelemetryData(period)
        .then((next) => {
          if (active) setTelemetry(next);
        })
        .catch(() => {});
    }, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sseConnected, period, fetchTelemetryData]);

  const handlePeriodChange = (nextPeriod) => {
    if (nextPeriod === period) return;
    setLoading(true);
    setPeriod(nextPeriod);
  };

  const selectActivityMode = (mode) => {
    if (mode === activityMode) return;
    if (mode === "24h") setLoading24h(true);
    setActivityMode(mode);
  };

  const handleSync = async () => {
    setLoading(true);
    if (activityMode === "24h") setLoading24h(true);
    try {
      const [nextTelemetry, next24h] = await Promise.all([
        fetchTelemetryData(period),
        activityMode === "24h"
          ? fetch24hChartData().catch(() => [])
          : Promise.resolve(null),
      ]);
      setTelemetry(nextTelemetry);
      if (next24h !== null) setChart24h(next24h);
    } finally {
      setLoading(false);
      if (activityMode === "24h") setLoading24h(false);
    }
  };

  const activeTierMeta = useMemo(
    () => THINKING_TIERS[thinkingTier] || THINKING_TIERS.xhigh,
    [thinkingTier]
  );

  const meshNodes = useMemo(() => {
    const usageTargets = Object.entries(telemetry.byProvider || {})
      .map(([provider, stats]) => ({
        provider,
        requests: Number(stats?.requests) || 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 4);

    if (usageTargets.length > 0) return usageTargets;

    return telemetry.activeProvidersList.map((item) => ({
      provider: item.provider,
      requests: item.connCount,
    }));
  }, [telemetry.byProvider, telemetry.activeProvidersList]);

  const pulseChart = useMemo(() => {
    const bars = telemetry.last10Minutes.length
      ? telemetry.last10Minutes
      : Array.from({ length: 10 }, () => ({
          requests: 0,
          errors: 0,
          promptTokens: 0,
          completionTokens: 0,
        }));
    return bars.map((b, i) => ({
      label: `-${bars.length - 1 - i}m`.replace("-0m", "now"),
      requests: Number(b?.requests) || 0,
      errors: Number(b?.errors) || 0,
      tokens: (Number(b?.promptTokens) || 0) + (Number(b?.completionTokens) || 0),
    }));
  }, [telemetry.last10Minutes]);

  const req10m = useMemo(
    () => pulseChart.reduce((sum, b) => sum + b.requests, 0),
    [pulseChart]
  );

  const err10m = useMemo(
    () => pulseChart.reduce((sum, b) => sum + b.errors, 0),
    [pulseChart]
  );

  const req24h = useMemo(
    () => chart24h.reduce((sum, b) => sum + b.requests, 0),
    [chart24h]
  );

  const err24h = useMemo(
    () => chart24h.reduce((sum, b) => sum + b.errors, 0),
    [chart24h]
  );

  const handleCopyModel = async () => {
    const value = `ag/${activeTierMeta.alias}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedModel(true);
      setTimeout(() => setCopiedModel(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const activeCount = telemetry.activeRequests.length;
  const formattedLastActivity = formatLastActivity(telemetry.lastActivityAt);
  const isIdle10m =
    activityMode === "10m" && req10m === 0 && err10m === 0 && activeCount === 0;
  const activeChartData = activityMode === "24h" ? chart24h : pulseChart;
  const activeErrors = activityMode === "24h" ? err24h : err10m;
  const showErrorsBar = activeErrors > 0;
  const endpointV1 = useMemo(() => {
    const clean = String(
      baseUrl || (typeof window !== "undefined" ? `${window.location.origin}/v1` : "http://localhost:20129/v1")
    ).replace(/\/+$/, "");
    return clean.endsWith("/v1") ? clean : `${clean}/v1`;
  }, [baseUrl]);

  const baseOrigin = endpointV1.replace(/\/v1$/, "");

  const sdkSnippets = useMemo(
    () => ({
      curl: `curl ${endpointV1}/chat/completions \\\n  -H "Authorization: Bearer ${sampleKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"ag/${activeTierMeta.alias}","messages":[{"role":"user","content":"ping"}]}'`,
      claude: `export ANTHROPIC_BASE_URL="${baseOrigin}"\nexport ANTHROPIC_AUTH_TOKEN="${sampleKey}"\nclaude --model "ag/${activeTierMeta.alias}"`,
      codex: `export OPENAI_BASE_URL="${endpointV1}"\nexport OPENAI_API_KEY="${sampleKey}"\ncodex -m "ag/${activeTierMeta.alias}"`,
      cursor: `// Cursor Settings -> Models -> Override OpenAI Base URL\nBase URL: ${endpointV1}\nAPI Key:  ${sampleKey}\nModel:    ag/${activeTierMeta.alias}`,
      opencode: `// ~/.config/opencode/opencode.json\n{\n  "provider": {\n    "888router": {\n      "options": { "baseURL": "${endpointV1}", "apiKey": "${sampleKey}" }\n    }\n  }\n}`,
      hermes: `# ~/.hermes/config.yaml\nmodel:\n  default: "ag/${activeTierMeta.alias}"\n  provider: "custom:888router"\nproviders:\n  888router:\n    base_url: "${endpointV1}"\n    api_key: "${sampleKey}"\n    default_model: "ag/${activeTierMeta.alias}"\n    session_affinity_header: "x-session-id"\n    discover_models: true\nweb:\n  backend: "888router-search"\n  base_url: "${endpointV1}/search"`,
    }),
    [activeTierMeta.alias, baseOrigin, endpointV1, sampleKey]
  );

  const handleCopySdk = async () => {
    try {
      await navigator.clipboard.writeText(sdkSnippets[sdkTab] || "");
      setCopiedSdk(true);
      setTimeout(() => setCopiedSdk(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="flex flex-col gap-4">
      {/* Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          <h1 className="text-sm font-semibold tracking-tight text-text-main m-0">
            Gateway Control & Virtual Keys
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-medium text-text-main">
            <span className={cn("size-1.5 rounded-full inline-block", sseConnected ? "bg-[#a6c23f]" : "bg-text-subtle")} />
            {sseConnected ? "Live SSE" : "Snapshot"}
          </span>
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border border-[#a6c23f]/50 bg-[#a6c23f]/15 px-2 py-0.5 text-[11px] font-medium text-text-main tabular-nums">
              {activeCount} active
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="inline-flex rounded-lg border border-border bg-bg-alt p-0.5" role="group" aria-label="Gateway metric window">
            {[
              { label: "Today", value: "today" },
              { label: "24H", value: "24h" },
              { label: "7D", value: "7d" },
              { label: "All", value: "all" },
            ].map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => handlePeriodChange(p.value)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer",
                  period === p.value
                    ? "bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111]"
                    : "text-text-muted hover:text-text-main"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleSync}
            className="h-7 px-3 rounded-lg border border-border bg-surface hover:bg-surface-2 text-xs font-medium text-text-main inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <ReloadOutlined spin={loading} className="text-[11px]" />
            Sync
          </button>
        </div>
      </div>

      {/* 4-Up Monochrome KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 tabular-nums">
        <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-xs font-medium text-text-muted">Routed ({period})</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-text-main">
            {formatCompactNumber(telemetry.totalRequests)}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">Requests in selected window</div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-xs font-medium text-text-muted">Total Tokens</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-text-main">
            {formatCompactNumber(telemetry.totalTokens)}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            {formatCompactNumber(telemetry.cachedTokens)} cached hits
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-xs font-medium text-text-muted">Providers & Combos</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-text-main">
            {telemetry.providersActive}/{telemetry.providersTotal}
            <span className="text-sm font-normal text-text-muted ml-2">· {telemetry.comboCount} combos</span>
          </div>
          <div className="mt-1 text-[11px] text-text-muted">Active upstreams ready</div>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="text-xs font-medium text-text-muted">Virtual API Keys</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-text-main">
            {loadingKeys ? "…" : apiKeyCount}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">Scoped gateway credentials</div>
        </div>
      </div>

      {/* Split Workspace: 7-col 10m/24h Traffic Cadence + Targets | 5-col SDK Quickstart */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        <div className="xl:col-span-7 min-w-0 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-bg-alt">
            <div>
              <h2 className="text-xs font-semibold text-text-main m-0">
                {activityMode === "24h" ? "24-Hour Gateway Activity" : "10-Minute Gateway Activity"}
              </h2>
              <p className="text-[11px] text-text-muted m-0">
                {activityMode === "24h"
                  ? "Hourly request & error cadence across the last 24 hours"
                  : "Live request cadence across upstream providers"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {activityMode === "10m" ? (
                <>
                  <span className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-main">
                    {req10m} req / 10m
                  </span>
                  {err10m > 0 && (
                    <span className="rounded-md border border-[#ef4444]/40 bg-[#ef4444]/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#ef4444]">
                      {err10m} err
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-main">
                    {req24h} req / 24h
                  </span>
                  {err24h > 0 && (
                    <span className="rounded-md border border-[#ef4444]/40 bg-[#ef4444]/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#ef4444]">
                      {err24h} err
                    </span>
                  )}
                </>
              )}

              <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Gateway activity window">
                {[
                  { label: "10m", value: "10m" },
                  { label: "24h", value: "24h" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => selectActivityMode(opt.value)}
                    aria-pressed={activityMode === opt.value}
                    className={cn(
                      "px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors cursor-pointer",
                      activityMode === opt.value
                        ? "bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111]"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-center">
            {isIdle10m ? (
              <div className="min-h-[160px] rounded-lg border border-dashed border-border bg-bg-alt/40 px-4 py-5 flex flex-col items-center justify-center text-center gap-1.5">
                <div className="text-xs font-medium text-text-main">
                  No requests in last 10m
                </div>
                <p className="text-[11px] text-text-muted m-0">
                  {formattedLastActivity ? `Last call: ${formattedLastActivity}` : "No recorded calls yet"}
                </p>
                <button
                  type="button"
                  onClick={() => selectActivityMode("24h")}
                  className="mt-1 px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text-main transition-colors cursor-pointer"
                >
                  View 24h pulse →
                </button>
              </div>
            ) : activityMode === "24h" && loading24h && chart24h.length === 0 ? (
              <div className="min-h-[160px] flex items-center justify-center text-xs text-text-muted">
                Loading 24h pulse…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={activeChartData} margin={{ top: 10, right: 6, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--color-border-subtle)" }}
                  />
                  <YAxis
                    allowDecimals={false}
                    domain={[0, (dataMax) => Math.max((dataMax || 0) + 1, 2)]}
                    tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--color-surface-2)", opacity: 0.55 }}
                    contentStyle={{
                      backgroundColor: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "8px",
                      boxShadow: "var(--shadow-elevated)",
                      fontSize: "12px",
                      color: "var(--color-text-main)",
                    }}
                    labelStyle={{ color: "var(--color-text-muted)", fontWeight: 600 }}
                    itemStyle={{ color: "var(--color-text-main)", fontFamily: "var(--font-mono)" }}
                  />
                  <Bar dataKey="requests" name="Requests" fill="var(--color-text-main)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
                    {activeChartData.map((entry, idx) => (
                      <Cell
                        key={`${entry.label}-${idx}`}
                        fill={
                          idx === activeChartData.length - 1
                            ? "var(--color-text-main)"
                            : "var(--color-border-strong)"
                        }
                      />
                    ))}
                  </Bar>
                  {showErrorsBar && (
                    <Bar
                      dataKey="errors"
                      name="Errors"
                      fill="#ef4444"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={18}
                      isAnimationActive={false}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="border-t border-border bg-bg-alt px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[11px] font-medium text-text-muted">Active Upstreams</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {meshNodes.length === 0 ? (
                <span className="text-[11px] text-text-subtle">No connected providers</span>
              ) : (
                meshNodes.map((n) => (
                  <span
                    key={n.provider}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-border bg-surface text-[11px] font-medium text-text-main"
                  >
                    <span className="size-1.5 rounded-full bg-[#a6c23f] inline-block" />
                    {n.provider}
                    <span className="font-mono text-text-muted tabular-nums">{n.requests}</span>
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: SDK & CLI Quickstart Switcher */}
        <div className="xl:col-span-5 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between min-w-0 overflow-hidden">
          <div>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-bg-alt">
              <span className="text-xs font-semibold text-text-main">
                SDK & CLI Quickstart
              </span>
              <button
                type="button"
                onClick={handleCopySdk}
                className="px-2.5 py-1 rounded-md border border-border bg-surface hover:bg-surface-2 text-[11px] font-medium text-text-main inline-flex items-center gap-1 cursor-pointer"
              >
                {copiedSdk ? <CheckOutlined /> : <CopyOutlined />}
                {copiedSdk ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="px-4 py-2 border-b border-border bg-bg-alt overflow-x-auto scroll-thin-x">
              <Segmented
                size="small"
                value={sdkTab}
                onChange={setSdkTab}
                options={SDK_OPTIONS}
              />
            </div>

            <pre className="p-3.5 bg-bg-alt/50 border-b border-border font-mono text-[11px] leading-relaxed text-text-main overflow-auto max-h-[156px] m-0">
              {sdkSnippets[sdkTab]}
            </pre>
          </div>

          <div className="p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-text-muted">
                ag/{activeTierMeta.alias}
              </span>
              <div className="flex items-center gap-1.5">
                <Segmented
                  size="small"
                  value={thinkingTier}
                  onChange={setThinkingTier}
                  options={[
                    { label: "low", value: "low" },
                    { label: "med", value: "medium" },
                    { label: "high", value: "high" },
                    { label: "xhigh", value: "xhigh" },
                  ]}
                />
                <button
                  type="button"
                  onClick={handleCopyModel}
                  className="h-6 px-2.5 rounded-md border border-border bg-bg-alt hover:bg-surface-2 text-[11px] font-medium text-text-main cursor-pointer"
                >
                  {copiedModel ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div className="border-t border-border-subtle pt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-1.5 text-text-muted min-w-0">
                <span>Last call:</span>
                {telemetry.recentRequests.length === 0 ? (
                  <span>None</span>
                ) : (
                  <span className="font-mono text-[11px] text-text-main truncate max-w-[160px]">
                    {telemetry.recentRequests[0].model}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0 font-medium">
                <Link href="/dashboard/usage?tab=details" className="text-text-main hover:underline">
                  Traces →
                </Link>
                <Link href="/dashboard/combos" className="text-text-main hover:underline">
                  Combos →
                </Link>
                <Link href="/dashboard/basic-chat" className="text-text-main hover:underline">
                  Test Chat →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
