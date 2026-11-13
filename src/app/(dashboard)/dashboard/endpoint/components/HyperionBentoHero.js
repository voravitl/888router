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

      const providerCounts = {};
      for (const c of activeConns) {
        const key = c.provider || "unknown";
        providerCounts[key] = (providerCounts[key] || 0) + 1;
      }
      const activeProvidersList = Object.entries(providerCounts)
        .map(([provider, connCount]) => ({ provider, connCount }))
        .sort((a, b) => b.connCount - a.connCount)
        .slice(0, 4);

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
          // Ignore malformed keepalive events
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
      : Array.from({ length: 10 }, () => ({ requests: 0, promptTokens: 0, completionTokens: 0 }));
    return bars.map((b, i) => ({
      label: `-${bars.length - 1 - i}m`.replace("-0m", "now"),
      requests: Number(b?.requests) || 0,
      tokens: (Number(b?.promptTokens) || 0) + (Number(b?.completionTokens) || 0),
    }));
  }, [telemetry.last10Minutes]);

  const req10m = useMemo(
    () => pulseChart.reduce((sum, b) => sum + b.requests, 0),
    [pulseChart]
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
                onClick={() => setPeriod(p.value)}
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
            onClick={() => loadTelemetry(period)}
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

      {/* Split Workspace: 7-col 10m Traffic Cadence + Targets | 5-col SDK Quickstart */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">
        <div className="xl:col-span-7 min-w-0 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col justify-between overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-bg-alt">
            <div>
              <h2 className="text-xs font-semibold text-text-main m-0">10-Minute Gateway Activity</h2>
              <p className="text-[11px] text-text-muted m-0">Live request cadence across upstream providers</p>
            </div>
            <span className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-main">
              {req10m} req / 10m
            </span>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-center">
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={pulseChart} margin={{ top: 10, right: 6, left: -24, bottom: 0 }}>
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
                  cursor={{ fill: "var(--color-surface-2)", opacity: 0.6 }}
                  contentStyle={{
                    backgroundColor: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Bar dataKey="requests" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
                  {pulseChart.map((entry, idx) => (
                    <Cell
                      key={entry.label}
                      fill={
                        idx === pulseChart.length - 1
                          ? "var(--color-text-main)"
                          : "var(--color-border-strong)"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
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

            <pre className="p-3.5 bg-bg-alt/50 border-b border-border font-mono text-[11px] leading-relaxed text-text-main overflow-x-auto max-h-[156px] m-0">
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
