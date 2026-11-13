"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Card, Tag, Statistic, Segmented, Button, Tooltip } from "antd";
import {
  BranchesOutlined,
  FileTextOutlined,
  ReloadOutlined,
  RocketOutlined,
  ApiOutlined,
  CopyOutlined,
  CheckOutlined,
  DashboardOutlined,
  HistoryOutlined,
  RadarChartOutlined,
} from "@ant-design/icons";

function formatCompactNumber(num) {
  const n = Number(num) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const THINKING_TIERS = {
  low: {
    alias: "gemini-4-hydrogen-low",
    upstream: "gemini-4-hydrogen(low)",
    badge: "FAST · 1M CTX",
    color: "cyan",
  },
  medium: {
    alias: "gemini-4-hydrogen-medium",
    upstream: "gemini-4-hydrogen(medium)",
    badge: "BALANCED · 1M CTX",
    color: "blue",
  },
  high: {
    alias: "gemini-4-hydrogen",
    upstream: "gemini-4-hydrogen(high)",
    badge: "DEFAULT · 64K OUT",
    color: "gold",
  },
  xhigh: {
    alias: "gemini-4-hydrogen-xhigh",
    upstream: "gemini-4-hydrogen(xhigh)",
    badge: "MAX REASONING",
    color: "purple",
  },
};

const MESH_COLORS = ["#f59e0b", "#06b6d4", "#a855f7"];

export default function HyperionBentoHero({ apiKeyCount = 0, loadingKeys = false }) {
  const [period, setPeriod] = useState("7d");
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
    byProvider: {},
    topModels: [],
    activeProvidersList: [],
    providersActive: 0,
    providersTotal: 0,
    comboCount: 0,
  });

  const loadTelemetry = useCallback(async (selectedPeriod) => {
    setLoading(true);
    try {
      const [statsRes, providersRes, combosRes] = await Promise.all([
        fetch(`/api/usage/stats?period=${selectedPeriod}`).catch(() => null),
        fetch("/api/providers").catch(() => null),
        fetch("/api/combos").catch(() => null),
      ]);

      const statsData = statsRes?.ok ? await statsRes.json() : {};
      const providersData = providersRes?.ok ? await providersRes.json() : {};
      const combosData = combosRes?.ok ? await combosRes.json() : {};

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

      // Count active connections per provider as fallback mesh nodes
      const providerCounts = {};
      for (const c of activeConns) {
        const key = c.provider || "unknown";
        providerCounts[key] = (providerCounts[key] || 0) + 1;
      }
      const activeProvidersList = Object.entries(providerCounts)
        .map(([provider, connCount]) => ({ provider, connCount }))
        .sort((a, b) => b.connCount - a.connCount)
        .slice(0, 3);

      setTelemetry({
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
        byProvider: statsData?.byProvider || {},
        topModels: byModelEntries,
        activeProvidersList,
        providersActive: activeConns.length,
        providersTotal: connections.length,
        comboCount: combos.length,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTelemetry(period);
  }, [period, loadTelemetry]);

  // Real-time SSE stream for live inflight & recent requests + 10m pulse
  useEffect(() => {
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
          }));
        } catch {
          // Ignore malformed keepalive/partial events
        }
      };
      es.onerror = () => setSseConnected(false);
    } catch {
      setSseConnected(false);
    }
    return () => {
      if (es) es.close();
    };
  }, []);

  const activeTierMeta = useMemo(
    () => THINKING_TIERS[thinkingTier] || THINKING_TIERS.xhigh,
    [thinkingTier]
  );

  // Build real mesh targets from byProvider usage in selected period,
  // falling back to active configured providers when period has 0 requests.
  const meshNodes = useMemo(() => {
    const usageTargets = Object.entries(telemetry.byProvider || {})
      .map(([provider, stats]) => ({
        provider,
        requests: Number(stats?.requests) || 0,
        tokens:
          (Number(stats?.promptTokens) || 0) +
          (Number(stats?.completionTokens) || 0),
        mode: "traffic",
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 3);

    if (usageTargets.length > 0) return usageTargets;

    return telemetry.activeProvidersList.map((item) => ({
      provider: item.provider,
      requests: item.connCount,
      tokens: 0,
      mode: "configured",
    }));
  }, [telemetry.byProvider, telemetry.activeProvidersList]);

  const pulseBars = useMemo(() => {
    const bars = telemetry.last10Minutes.length
      ? telemetry.last10Minutes
      : Array.from({ length: 10 }, () => ({ requests: 0 }));
    const maxReq = Math.max(1, ...bars.map((b) => Number(b?.requests) || 0));
    return bars.map((b) => ({
      requests: Number(b?.requests) || 0,
      pct: Math.max(12, Math.round(((Number(b?.requests) || 0) / maxReq) * 100)),
    }));
  }, [telemetry.last10Minutes]);

  const handleCopyModel = async () => {
    const value = `ag/${activeTierMeta.alias}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedModel(true);
      setTimeout(() => setCopiedModel(false), 1800);
    } catch {
      // Clipboard blocked in non-HTTPS contexts
    }
  };

  const hasTraffic = telemetry.totalRequests > 0;
  const activeCount = telemetry.activeRequests.length;

  return (
    <section className="stagger-in flex flex-col gap-4">
      <Card
        variant="borderless"
        className="hyperion-card aurora-border !bg-surface/90 backdrop-blur-xl"
        styles={{ body: { padding: "22px 24px" } }}
      >
        <div className="relative z-10 flex flex-col gap-5">
          {/* Top Command Header */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="size-11 rounded-xl bg-gradient-to-br from-amber-500/20 via-amber-500/10 to-cyan-500/20 border border-amber-500/35 flex items-center justify-center shrink-0 shadow-[0_0_24px_rgba(245,158,11,0.18)]">
                <ApiOutlined className="text-xl text-amber-400" />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono uppercase tracking-[0.18em] text-amber-400/90 font-semibold">
                    Hyperion Control Plane
                  </span>
                  <Tag
                    color={sseConnected ? "green" : "gold"}
                    variant="filled"
                    className="!m-0 !rounded-full !text-[10px] !font-mono !px-2"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`beacon-dot size-1.5 rounded-full ${
                          sseConnected ? "bg-emerald-400" : "bg-amber-400"
                        }`}
                      />
                      {sseConnected ? "LIVE SSE TELEMETRY" : "DB SNAPSHOT"}
                    </span>
                  </Tag>
                  {activeCount > 0 && (
                    <Tag
                      color="cyan"
                      variant="filled"
                      className="!m-0 !rounded-full !text-[10px] !font-mono !px-2"
                    >
                      {activeCount} INFLIGHT
                    </Tag>
                  )}
                </div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-main m-0">
                  888router Live Telemetry
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Segmented
                size="small"
                value={period}
                onChange={setPeriod}
                options={[
                  { label: "Today", value: "today" },
                  { label: "24h", value: "24h" },
                  { label: "7d", value: "7d" },
                  { label: "All", value: "all" },
                ]}
              />
              <Tooltip title="Refresh live metrics from SQLite">
                <Button
                  size="medium"
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={() => loadTelemetry(period)}
                >
                  Refresh
                </Button>
              </Tooltip>
            </div>
          </div>

          {/* 4-Column Real DB Bento Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <div className="rounded-xl border border-border/80 bg-surface-2/65 p-3.5 hover:border-amber-500/40 transition-colors">
              <Statistic
                title={
                  <span className="text-[11px] font-mono uppercase tracking-wider text-text-muted">
                    Routed Requests ({period})
                  </span>
                }
                value={telemetry.totalRequests}
                loading={loading}
                styles={{
                  content: {
                    color: "#f59e0b",
                    fontSize: "24px",
                    fontWeight: 700,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                  },
                }}
                suffix={
                  <span
                    className={`text-[11px] font-mono ml-1 ${
                      activeCount > 0 ? "text-emerald-400" : "text-text-muted"
                    }`}
                  >
                    {activeCount > 0 ? `${activeCount} inflight` : "0 inflight"}
                  </span>
                }
              />
            </div>

            <div className="rounded-xl border border-border/80 bg-surface-2/65 p-3.5 hover:border-cyan-500/40 transition-colors">
              <Statistic
                title={
                  <span className="text-[11px] font-mono uppercase tracking-wider text-text-muted">
                    Tokens Processed ({period})
                  </span>
                }
                value={formatCompactNumber(telemetry.totalTokens)}
                loading={loading}
                styles={{
                  content: {
                    color: "#06b6d4",
                    fontSize: "24px",
                    fontWeight: 700,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                  },
                }}
                suffix={
                  <span className="text-[11px] font-mono text-text-muted ml-1">
                    {formatCompactNumber(telemetry.cachedTokens)} cached
                  </span>
                }
              />
            </div>

            <div className="rounded-xl border border-border/80 bg-surface-2/65 p-3.5 hover:border-emerald-500/40 transition-colors">
              <Statistic
                title={
                  <span className="text-[11px] font-mono uppercase tracking-wider text-text-muted">
                    Active Providers & Combos
                  </span>
                }
                value={telemetry.providersActive}
                loading={loading}
                styles={{
                  content: {
                    color: "#10b981",
                    fontSize: "24px",
                    fontWeight: 700,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                  },
                }}
                suffix={
                  <span className="text-[11px] font-mono text-text-muted ml-1">
                    / {telemetry.providersTotal} · {telemetry.comboCount} combos
                  </span>
                }
              />
            </div>

            <div className="rounded-xl border border-border/80 bg-surface-2/65 p-3.5 hover:border-purple-500/40 transition-colors">
              <Statistic
                title={
                  <span className="text-[11px] font-mono uppercase tracking-wider text-text-muted">
                    Gateway API Keys
                  </span>
                }
                value={apiKeyCount}
                loading={loadingKeys}
                styles={{
                  content: {
                    color: "#a855f7",
                    fontSize: "24px",
                    fontWeight: 700,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                  },
                }}
                suffix={
                  <span className="text-[11px] font-mono text-text-muted ml-1">
                    active keys
                  </span>
                }
              />
            </div>
          </div>

          {/* Live Mesh Routing + Real Activity Stream & Hydrogen Alias Helper */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            {/* Real Provider Mesh SVG + 10m Sparkline (7 cols) */}
            <div className="lg:col-span-7 rounded-xl border border-border/80 bg-black/25 p-4 flex flex-col justify-between gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <RadarChartOutlined className="text-amber-400" />
                  <span className="text-xs font-mono font-semibold uppercase tracking-wider text-text-main">
                    {hasTraffic
                      ? `Live Provider Distribution (${period})`
                      : "Active Configured Providers"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-text-muted uppercase">
                    10m Pulse
                  </span>
                  <div
                    className="flex items-end gap-0.5 h-4 px-1.5 py-0.5 rounded bg-surface-2/80 border border-border/60"
                    title="Real requests per minute over the last 10 minutes"
                  >
                    {pulseBars.map((bar, idx) => (
                      <span
                        key={idx}
                        className="w-1 rounded-sm bg-cyan-400/80 transition-all"
                        style={{ height: `${bar.pct}%` }}
                        title={`${bar.requests} req`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <svg
                viewBox="0 0 640 120"
                className="w-full h-[112px] overflow-visible select-none"
                role="img"
                aria-label="888router Real Provider Routing Distribution"
              >
                <defs>
                  <linearGradient id="hyperionRealLine" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.95" />
                    <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.95" />
                  </linearGradient>
                </defs>

                {[24, 60, 96].map((y, idx) => {
                  const node = meshNodes[idx];
                  const color = MESH_COLORS[idx % MESH_COLORS.length];
                  return (
                    <path
                      key={y}
                      d={`M 136 60 C 215 60, 225 ${y}, 308 ${y}`}
                      fill="none"
                      stroke={node ? (idx === 0 ? "url(#hyperionRealLine)" : color) : "#27272a"}
                      strokeWidth={node ? (activeCount > 0 ? "2.6" : "2") : "1.2"}
                      strokeOpacity={node ? 0.85 : 0.4}
                      className={
                        node
                          ? activeCount > 0
                            ? "flow-line-fast"
                            : "flow-line"
                          : ""
                      }
                    />
                  );
                })}

                {/* Hub Node */}
                <g transform="translate(8, 34)">
                  <rect
                    width="128"
                    height="52"
                    rx="10"
                    fill="#14141a"
                    stroke="#f59e0b"
                    strokeOpacity="0.7"
                  />
                  <text x="14" y="22" fill="#f59e0b" fontSize="10" fontFamily="monospace" fontWeight="700">
                    888ROUTER HUB
                  </text>
                  <text x="14" y="38" fill="#a1a1aa" fontSize="10" fontFamily="monospace">
                    {telemetry.providersActive} active nodes
                  </text>
                </g>

                {/* Top 3 Real Providers */}
                {[0, 1, 2].map((idx) => {
                  const y = idx === 0 ? 6 : idx === 1 ? 44 : 82;
                  const node = meshNodes[idx];
                  const color = MESH_COLORS[idx % MESH_COLORS.length];
                  return (
                    <g key={idx} transform={`translate(308, ${y})`}>
                      <rect
                        width="324"
                        height="32"
                        rx="8"
                        fill="#14141a"
                        stroke={node ? color : "#27272a"}
                        strokeOpacity={node ? 0.6 : 0.5}
                      />
                      <circle cx="16" cy="16" r="4" fill={node ? color : "#52525b"} />
                      <text x="28" y="20" fill={node ? "#fafafa" : "#71717a"} fontSize="11" fontFamily="monospace" fontWeight="700">
                        {node ? node.provider : "No additional provider"}
                      </text>
                      {node && (
                        <text x="195" y="20" fill={color} fontSize="10" fontFamily="monospace">
                          {node.mode === "traffic"
                            ? `${node.requests} req · ${formatCompactNumber(node.tokens)} tok`
                            : `${node.requests} conn configured`}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {telemetry.topModels.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
                  <span className="text-[11px] font-mono text-text-muted">Top Models:</span>
                  {telemetry.topModels.map((m) => (
                    <Tag key={m.name} variant="outlined" className="!m-0 !font-mono !text-[11px]">
                      {m.name} ({m.requests})
                    </Tag>
                  ))}
                </div>
              )}
            </div>

            {/* Right Panel: Live Recent Calls + Hydrogen Copy Shortcut + Quick Nav (5 cols) */}
            <div className="lg:col-span-5 rounded-xl border border-border/80 bg-surface-2/60 p-4 flex flex-col justify-between gap-3">
              {/* Latest Actual Requests */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-mono font-semibold uppercase tracking-wider text-text-main">
                    <HistoryOutlined className="text-cyan-400" />
                    Latest Routed Calls
                  </span>
                  <Link href="/dashboard/usage?tab=details" className="text-[11px] font-mono text-amber-400 hover:underline">
                    View all →
                  </Link>
                </div>
                {telemetry.recentRequests.length === 0 ? (
                  <div className="rounded-lg bg-black/30 border border-border/60 px-3 py-2 text-xs text-text-muted font-mono">
                    No recorded requests yet.
                  </div>
                ) : (
                  <div className="rounded-lg bg-black/30 border border-border/60 divide-y divide-border/40">
                    {telemetry.recentRequests.slice(0, 3).map((req, idx) => {
                      const ok = !req.status || req.status === "ok" || req.status === "success";
                      return (
                        <div key={idx} className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] font-mono">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`size-1.5 rounded-full shrink-0 ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
                            <span className="truncate text-text-main" title={`${req.model} (${req.provider})`}>
                              {req.model}
                            </span>
                          </div>
                          <span className="text-text-muted shrink-0">
                            {formatCompactNumber(req.promptTokens)}↑ {formatCompactNumber(req.completionTokens)}↓
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Gemini 4 Hydrogen Quick Copy Selector */}
              <div className="flex flex-col gap-1.5 pt-2 border-t border-border/60">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-amber-300">
                    Gemini 4 Hydrogen Alias
                  </span>
                  <Tag color={activeTierMeta.color} variant="filled" className="!m-0 !font-mono !text-[10px]">
                    {activeTierMeta.badge}
                  </Tag>
                </div>
                <div className="flex items-center gap-2">
                  <Segmented
                    block
                    size="small"
                    value={thinkingTier}
                    onChange={setThinkingTier}
                    className="flex-1"
                    options={[
                      { label: "low", value: "low" },
                      { label: "med", value: "medium" },
                      { label: "high", value: "high" },
                      { label: "xhigh", value: "xhigh" },
                    ]}
                  />
                  <Tooltip title={`Copy ag/${activeTierMeta.alias}`}>
                    <Button
                      size="small"
                      icon={copiedModel ? <CheckOutlined /> : <CopyOutlined />}
                      onClick={handleCopyModel}
                    >
                      {copiedModel ? "Copied" : "Copy"}
                    </Button>
                  </Tooltip>
                </div>
              </div>

              {/* Shortcut Strip */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/60">
                <Link href="/dashboard/combos">
                  <Button size="small" icon={<BranchesOutlined />}>
                    Combos
                  </Button>
                </Link>
                <Link href="/dashboard/console-log">
                  <Button size="small" icon={<FileTextOutlined />}>
                    Logs
                  </Button>
                </Link>
                <Link href="/dashboard/usage">
                  <Button size="small" icon={<DashboardOutlined />}>
                    Usage
                  </Button>
                </Link>
                <Link href="/dashboard/basic-chat">
                  <Button size="small" type="primary" icon={<RocketOutlined />}>
                    Test Chat
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </section>
  );
}
