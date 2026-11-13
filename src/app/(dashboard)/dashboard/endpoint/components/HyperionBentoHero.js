"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Card, Tag, Statistic, Segmented, Button, Tooltip } from "antd";
import {
  ThunderboltOutlined,
  BranchesOutlined,
  FileTextOutlined,
  ReloadOutlined,
  RocketOutlined,
  ApiOutlined,
  SafetyCertificateOutlined,
  DashboardOutlined,
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
    latency: "~0.8s TTFT",
    color: "cyan",
  },
  medium: {
    alias: "gemini-4-hydrogen-medium",
    upstream: "gemini-4-hydrogen(medium)",
    badge: "BALANCED · 1M CTX",
    latency: "~1.4s TTFT",
    color: "blue",
  },
  high: {
    alias: "gemini-4-hydrogen",
    upstream: "gemini-4-hydrogen(high)",
    badge: "DEFAULT · 64K OUT",
    latency: "~2.6s TTFT",
    color: "gold",
  },
  xhigh: {
    alias: "gemini-4-hydrogen-xhigh",
    upstream: "gemini-4-hydrogen(xhigh)",
    badge: "MAX REASONING",
    latency: "Deep CoT",
    color: "purple",
  },
};

export default function HyperionBentoHero({ apiKeyCount = 0, loadingKeys = false }) {
  const [period, setPeriod] = useState("24h");
  const [thinkingTier, setThinkingTier] = useState("xhigh");
  const [burstMode, setBurstMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [telemetry, setTelemetry] = useState({
    totalRequests: 0,
    totalTokens: 0,
    cachedTokens: 0,
    activeRequests: 0,
    providersActive: 0,
    providersTotal: 0,
    comboCount: 0,
    topModels: [],
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

      setTelemetry({
        totalRequests: Number(statsData?.totalRequests) || 0,
        totalTokens: totalPrompt + totalCompletion,
        cachedTokens: cached,
        activeRequests: Array.isArray(statsData?.activeRequests)
          ? statsData.activeRequests.length
          : 0,
        providersActive: activeConns.length,
        providersTotal: connections.length,
        comboCount: combos.length,
        topModels: byModelEntries,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTelemetry(period);
  }, [period, loadTelemetry]);

  useEffect(() => {
    if (!burstMode) return undefined;
    const timer = setTimeout(() => setBurstMode(false), 6500);
    return () => clearTimeout(timer);
  }, [burstMode]);

  const activeTierMeta = useMemo(
    () => THINKING_TIERS[thinkingTier] || THINKING_TIERS.xhigh,
    [thinkingTier]
  );

  return (
    <section className="stagger-in flex flex-col gap-4">
      {/* Main Obsidian Aurora Hero Command Deck */}
      <Card
        variant="borderless"
        className="hyperion-card aurora-border scan-sweep !bg-surface/90 backdrop-blur-xl"
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
                    Hyperion Neural Mesh
                  </span>
                  <Tag
                    color="gold"
                    variant="filled"
                    className="!m-0 !rounded-full !text-[10px] !font-mono !px-2"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span className="beacon-dot size-1.5 rounded-full bg-amber-400" />
                      GATEWAY ONLINE
                    </span>
                  </Tag>
                  <Tag
                    color="cyan"
                    variant="filled"
                    className="!m-0 !rounded-full !text-[10px] !font-mono !px-2"
                  >
                    ANTIGRAVITY 2.31.2 · HYDROGEN
                  </Tag>
                </div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-text-main m-0">
                  888router Control Telemetry
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <Segmented
                size="small"
                value={period}
                onChange={setPeriod}
                options={[
                  { label: "24h", value: "24h" },
                  { label: "7d", value: "7d" },
                  { label: "All", value: "all" },
                ]}
              />
              <Tooltip title="Animate neural packet surge across provider mesh">
                <Button
                  size="medium"
                  type={burstMode ? "primary" : "default"}
                  icon={<ThunderboltOutlined />}
                  onClick={() => setBurstMode((v) => !v)}
                  className={burstMode ? "!shadow-[0_0_20px_rgba(245,158,11,0.45)]" : ""}
                >
                  {burstMode ? "Surge Active" : "Simulate Burst"}
                </Button>
              </Tooltip>
              <Tooltip title="Refresh live metrics">
                <Button
                  size="medium"
                  icon={<ReloadOutlined spin={loading} />}
                  onClick={() => loadTelemetry(period)}
                />
              </Tooltip>
            </div>
          </div>

          {/* 4-Column Kinetic Bento Metrics */}
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
                  <span className="text-[11px] font-mono text-emerald-400 ml-1">
                    {telemetry.activeRequests > 0
                      ? `${telemetry.activeRequests} live`
                      : "idle"}
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
                    Mesh Providers & Combos
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
                    Gateway Keys & Isolation
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
                    keys · RBAC on
                  </span>
                }
              />
            </div>
          </div>

          {/* Interactive Neural Routing Pipeline + Gemini 4 Hydrogen Lab */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            {/* Animated SVG Routing Mesh (7 cols) */}
            <div className="lg:col-span-7 rounded-xl border border-border/80 bg-black/25 p-4 flex flex-col justify-between gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <SafetyCertificateOutlined className="text-amber-400" />
                  <span className="text-xs font-mono font-semibold uppercase tracking-wider text-text-main">
                    Neural Routing Pipeline
                  </span>
                </div>
                <span className="text-[11px] font-mono text-cyan-400">
                  {burstMode ? "⚡ HIGH-VELOCITY BURST" : "SSE / REST STREAM READY"}
                </span>
              </div>

              <svg
                viewBox="0 0 640 120"
                className="w-full h-[108px] overflow-visible select-none"
                role="img"
                aria-label="888router Neural Routing Pipeline"
              >
                <defs>
                  <linearGradient id="hyperionAmberLine" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.95" />
                    <stop offset="50%" stopColor="#06b6d4" stopOpacity="0.95" />
                    <stop offset="100%" stopColor="#a855f7" stopOpacity="0.95" />
                  </linearGradient>
                </defs>

                {/* Curved SVG Flow Paths */}
                <path
                  d="M 136 60 C 210 60, 225 24, 308 24"
                  fill="none"
                  stroke="url(#hyperionAmberLine)"
                  strokeWidth={burstMode ? "3" : "2"}
                  className={burstMode ? "flow-line-fast" : "flow-line"}
                />
                <path
                  d="M 136 60 C 215 60, 230 60, 308 60"
                  fill="none"
                  stroke="#06b6d4"
                  strokeWidth={burstMode ? "3" : "2"}
                  strokeOpacity="0.8"
                  className={burstMode ? "flow-line-fast" : "flow-line"}
                />
                <path
                  d="M 136 60 C 210 60, 225 96, 308 96"
                  fill="none"
                  stroke="#a855f7"
                  strokeWidth={burstMode ? "3" : "2"}
                  strokeOpacity="0.75"
                  className={burstMode ? "flow-line-fast" : "flow-line"}
                />

                {/* Ingress Node */}
                <g transform="translate(8, 36)">
                  <rect
                    width="128"
                    height="48"
                    rx="10"
                    fill="#14141a"
                    stroke="#f59e0b"
                    strokeOpacity="0.65"
                  />
                  <text x="14" y="21" fill="#f59e0b" fontSize="10" fontFamily="monospace" fontWeight="700">
                    888ROUTER HUB
                  </text>
                  <text x="14" y="37" fill="#a1a1aa" fontSize="10" fontFamily="monospace">
                    /v1 · OpenAI / Claude
                  </text>
                </g>

                {/* Upstream Model Nodes */}
                <g transform="translate(308, 6)">
                  <rect
                    width="324"
                    height="34"
                    rx="8"
                    fill="#16161e"
                    stroke="#f59e0b"
                    strokeOpacity="0.75"
                  />
                  <circle cx="16" cy="17" r="4" fill="#f59e0b" />
                  <text x="28" y="21" fill="#fafafa" fontSize="11" fontFamily="monospace" fontWeight="700">
                    {activeTierMeta.upstream}
                  </text>
                  <text x="242" y="21" fill="#fbbf24" fontSize="10" fontFamily="monospace">
                    {activeTierMeta.latency}
                  </text>
                </g>

                <g transform="translate(308, 44)">
                  <rect
                    width="324"
                    height="32"
                    rx="8"
                    fill="#14141a"
                    stroke="#06b6d4"
                    strokeOpacity="0.45"
                  />
                  <circle cx="16" cy="16" r="4" fill="#06b6d4" />
                  <text x="28" y="20" fill="#e4e4e7" fontSize="11" fontFamily="monospace">
                    gemini-4-argon(high) · Claude · Codex
                  </text>
                  <text x="266" y="20" fill="#22d3ee" fontSize="10" fontFamily="monospace">
                    READY
                  </text>
                </g>

                <g transform="translate(308, 82)">
                  <rect
                    width="324"
                    height="32"
                    rx="8"
                    fill="#14141a"
                    stroke="#a855f7"
                    strokeOpacity="0.45"
                  />
                  <circle cx="16" cy="16" r="4" fill="#a855f7" />
                  <text x="28" y="20" fill="#e4e4e7" fontSize="11" fontFamily="monospace">
                    Combos · Auto-Fallback ({telemetry.comboCount})
                  </text>
                  <text x="264" y="20" fill="#c084fc" fontSize="10" fontFamily="monospace">
                    ROUTED
                  </text>
                </g>
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

            {/* Gemini 4 Hydrogen Thinking Tier Preview & Quick Launchpad (5 cols) */}
            <div className="lg:col-span-5 rounded-xl border border-border/80 bg-surface-2/60 p-4 flex flex-col justify-between gap-3">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono font-semibold uppercase tracking-wider text-amber-300">
                    Gemini 4 Hydrogen Effort
                  </span>
                  <Tag color={activeTierMeta.color} variant="filled" className="!m-0 !font-mono !text-[10px]">
                    {activeTierMeta.badge}
                  </Tag>
                </div>

                <Segmented
                  block
                  size="small"
                  value={thinkingTier}
                  onChange={setThinkingTier}
                  options={[
                    { label: "low", value: "low" },
                    { label: "medium", value: "medium" },
                    { label: "high", value: "high" },
                    { label: "xhigh", value: "xhigh" },
                  ]}
                />

                <div className="rounded-lg bg-black/35 border border-border/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
                  <div>
                    <span className="text-zinc-500">model: </span>
                    <span className="text-amber-300">{`ag/${activeTierMeta.alias}`}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">upstream: </span>
                    <span className="text-cyan-300">{activeTierMeta.upstream}</span>
                  </div>
                </div>
              </div>

              {/* Direct Shortcut Strip to Preserved Workflows */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/60">
                <Link href="/dashboard/combos">
                  <Button size="small" icon={<BranchesOutlined />}>
                    Combos
                  </Button>
                </Link>
                <Link href="/dashboard/console-log">
                  <Button size="small" icon={<FileTextOutlined />}>
                    Console Log
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
