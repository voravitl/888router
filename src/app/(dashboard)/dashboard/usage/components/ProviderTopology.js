"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import PropTypes from "prop-types";
import { Segmented } from "antd";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { cn } from "@/shared/utils/cn";

const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return `/providers/${providerId}.png`;
}

function fmtCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function ProviderMark({ providerId, label, textIcon, color }) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className="size-7 rounded-lg border border-border bg-bg-alt flex items-center justify-center shrink-0">
      {!imgError ? (
        <img
          src={getProviderImageUrl(providerId)}
          alt={label}
          className="size-4 object-contain"
          onError={() => setImgError(true)}
        />
      ) : (
        <span className="font-mono text-[10px] font-semibold" style={{ color }}>
          {textIcon}
        </span>
      )}
    </div>
  );
}

ProviderMark.propTypes = {
  providerId: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  textIcon: PropTypes.string.isRequired,
  color: PropTypes.string,
};

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
  byProvider = {},
  byModel = {},
  byEndpoint = {},
  totalRequests = 0,
  totalPromptTokens = 0,
  totalCachedTokens = 0,
}) {
  const [viewMode, setViewMode] = useState("flow");
  const [showStandby, setShowStandby] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState(null);

  const activeKey = useMemo(
    () =>
      activeRequests
        .map((r) => r.provider?.toLowerCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [activeRequests]
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActiveSet = useMemo(() => new Set(activeKey ? activeKey.split(",") : []), [activeKey]);
  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set(errorKey ? [errorKey] : []), [errorKey]);

  const firstSeenRef = useRef({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const p of rawActiveSet) {
      if (!seen[p]) seen[p] = now;
    }
    for (const p of Object.keys(seen)) {
      if (!rawActiveSet.has(p)) delete seen[p];
    }
  }, [rawActiveSet]);

  useEffect(() => {
    if (rawActiveSet.size === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActiveSet]);

  const activeSet = useMemo(() => {
    const now = Date.now();
    const filtered = new Set();
    for (const p of rawActiveSet) {
      const ts = firstSeenRef.current[p];
      if (!ts || now - ts < FE_ACTIVE_TIMEOUT_MS) filtered.add(p);
    }
    return filtered;
  }, [rawActiveSet, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aggregate active in-flight counts per provider
  const activeCountByProvider = useMemo(() => {
    const map = {};
    for (const r of activeRequests || []) {
      const k = r.provider?.toLowerCase();
      if (k) map[k] = (map[k] || 0) + (Number(r.count) || 1);
    }
    return map;
  }, [activeRequests]);

  // Build normalized upstream target entries combining connected list + observed traffic
  const allTargets = useMemo(() => {
    const byProvNorm = {};
    for (const [k, v] of Object.entries(byProvider || {})) {
      byProvNorm[k.toLowerCase()] = v;
    }

    const totalTraffic = Object.values(byProvNorm).reduce((s, p) => s + (Number(p?.requests) || 0), 0);
    const seen = new Set();
    const list = [];

    const addEntry = (idRaw, conn) => {
      if (!idRaw) return;
      const lower = idRaw.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);

      const config = getProviderConfig(idRaw);
      const stat = byProvNorm[lower] || {};
      const requests = Number(stat.requests) || 0;
      const promptTok = Number(stat.promptTokens) || 0;
      const completionTok = Number(stat.completionTokens) || 0;
      const cost = Number(stat.cost) || 0;
      const active = activeSet.has(lower);
      const error = !active && errorSet.has(lower);
      const last = !active && !error && lastSet.has(lower);
      const hasConnection = Boolean(conn?.id);
      const isNoAuthFree = Boolean(config.noAuth && !hasConnection);

      list.push({
        id: idRaw,
        lower,
        label: (config.name !== idRaw ? config.name : null) || conn?.nodeName || conn?.name || idRaw,
        color: config.color || "#6b7280",
        textIcon: config.textIcon || idRaw.slice(0, 2).toUpperCase(),
        requests,
        sharePct: totalTraffic > 0 ? Math.round((requests / totalTraffic) * 100) : 0,
        tokens: promptTok + completionTok,
        promptTokens: promptTok,
        completionTokens: completionTok,
        cost,
        active,
        inFlightCount: activeCountByProvider[lower] || 0,
        last,
        error,
        hasConnection,
        isNoAuthFree,
      });
    };

    for (const p of providers) addEntry(p.provider, p);
    for (const k of Object.keys(byProvNorm)) addEntry(k, null);

    // Sort: active -> error -> last -> requests desc -> configured before standby -> alphabetical
    return list.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.error !== b.error) return a.error ? -1 : 1;
      if (a.last !== b.last) return a.last ? -1 : 1;
      if (b.requests !== a.requests) return b.requests - a.requests;
      if (a.isNoAuthFree !== b.isNoAuthFree) return a.isNoAuthFree ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }, [providers, byProvider, activeSet, lastSet, errorSet, activeCountByProvider]);

  const { primaryTargets, standbyTargets } = useMemo(() => {
    const primary = [];
    const standby = [];
    for (const t of allTargets) {
      if (t.isNoAuthFree && t.requests === 0 && !t.active && !t.last && !t.error) {
        standby.push(t);
      } else {
        primary.push(t);
      }
    }
    // Always show all if nothing primary exists yet
    if (primary.length === 0) return { primaryTargets: standby, standbyTargets: [] };
    return { primaryTargets: primary, standbyTargets: standby };
  }, [allTargets]);

  const visibleTargets = useMemo(
    () => (showStandby ? allTargets : primaryTargets).slice(0, 10),
    [showStandby, allTargets, primaryTargets]
  );

  // Build ingress endpoints (Left stage)
  const ingressNodes = useMemo(() => {
    const entries = Object.entries(byEndpoint || {})
      .map(([ep, data]) => ({
        endpoint: ep,
        requests: Number(data?.requests) || 0,
        tokens: (Number(data?.promptTokens) || 0) + (Number(data?.completionTokens) || 0),
      }))
      .filter((e) => e.requests > 0)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 4);

    if (entries.length > 0) return entries;
    return [
      { endpoint: "/v1/chat/completions", requests: totalRequests || 0, tokens: 0 },
      { endpoint: "/v1/messages", requests: 0, tokens: 0 },
    ];
  }, [byEndpoint, totalRequests]);

  const computedTotalRequests = useMemo(() => {
    if (totalRequests > 0) return totalRequests;
    return allTargets.reduce((sum, t) => sum + t.requests, 0);
  }, [totalRequests, allTargets]);

  const cacheHitPct = totalPromptTokens > 0
    ? Math.min(100, Math.round((totalCachedTokens / totalPromptTokens) * 100))
    : 0;

  const selectedTarget = useMemo(() => {
    if (!selectedProviderId) return null;
    return allTargets.find((t) => t.id === selectedProviderId) || null;
  }, [allTargets, selectedProviderId]);

  const selectedModels = useMemo(() => {
    if (!selectedTarget) return [];
    return Object.entries(byModel || {})
      .filter(([, v]) => (v?.provider || "").toLowerCase() === selectedTarget.lower)
      .map(([name, v]) => ({
        name,
        requests: Number(v?.requests) || 0,
        tokens: (Number(v?.promptTokens) || 0) + (Number(v?.completionTokens) || 0),
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 4);
  }, [selectedTarget, byModel]);

  // Measure DOM port anchor points for crisp SVG cubic bezier bus
  const canvasRef = useRef(null);
  const ingressPortRefs = useRef([]);
  const coreInPortRef = useRef(null);
  const coreOutPortRef = useRef(null);
  const targetPortRefs = useRef([]);
  const [busPaths, setBusPaths] = useState({ width: 0, height: 0, left: [], right: [] });

  const recomputeBus = useCallback(() => {
    const container = canvasRef.current;
    const coreIn = coreInPortRef.current;
    const coreOut = coreOutPortRef.current;
    if (!container || !coreIn || !coreOut) return;

    const baseRect = container.getBoundingClientRect();
    if (baseRect.width < 520) {
      setBusPaths({ width: baseRect.width, height: baseRect.height, left: [], right: [] });
      return;
    }

    const relCenter = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left - baseRect.left + r.width / 2,
        y: r.top - baseRect.top + r.height / 2,
      };
    };

    const inPt = relCenter(coreIn);
    const outPt = relCenter(coreOut);

    const leftCurves = ingressNodes
      .map((node, i) => {
        const port = ingressPortRefs.current[i];
        if (!port) return null;
        const p = relCenter(port);
        const cx = (p.x + inPt.x) / 2;
        return {
          id: `in-${node.endpoint}`,
          d: `M ${p.x} ${p.y} C ${cx} ${p.y}, ${cx} ${inPt.y}, ${inPt.x} ${inPt.y}`,
          active: activeSet.size > 0 && node.requests > 0,
          hasTraffic: node.requests > 0,
          end: p,
        };
      })
      .filter(Boolean);

    const rightCurves = visibleTargets
      .map((target, i) => {
        const port = targetPortRefs.current[i];
        if (!port) return null;
        const p = relCenter(port);
        const cx = (outPt.x + p.x) / 2;
        return {
          id: `out-${target.id}`,
          d: `M ${outPt.x} ${outPt.y} C ${cx} ${outPt.y}, ${cx} ${p.y}, ${p.x} ${p.y}`,
          target,
          end: p,
        };
      })
      .filter(Boolean);

    setBusPaths({
      width: baseRect.width,
      height: baseRect.height,
      left: leftCurves,
      right: rightCurves,
    });
  }, [ingressNodes, visibleTargets, activeSet]);

  useEffect(() => {
    if (viewMode !== "flow") return;
    const id = requestAnimationFrame(() => recomputeBus());
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(id);
    const ro = new ResizeObserver(() => requestAnimationFrame(() => recomputeBus()));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [viewMode, recomputeBus, selectedTarget]);

  const activeTotalCount = Object.values(activeCountByProvider).reduce((s, n) => s + n, 0);

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col overflow-hidden min-w-0">
      {/* Header Bar */}
      <div className="px-4 py-3 border-b border-border bg-bg-alt flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <h2 className="text-xs font-semibold text-text-main m-0">Routing Topology</h2>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-muted tabular-nums">
            <span
              className={cn(
                "size-1.5 rounded-full inline-block",
                activeTotalCount > 0 ? "bg-[#a6c23f]" : "bg-text-subtle"
              )}
            />
            {activeTotalCount > 0 ? `${activeTotalCount} live` : `${primaryTargets.length} upstreams`}
          </span>
          {errorSet.size > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border border-red-600/30 bg-red-600/10 px-2 py-0.5 text-[11px] font-medium text-[#dc2626]">
              Error detected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Segmented
            size="small"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { label: "Flow", value: "flow" },
              { label: "Paths", value: "paths" },
            ]}
          />
        </div>
      </div>

      {allTargets.length === 0 ? (
        <div className="h-[300px] sm:h-[360px] flex flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="text-xs font-medium text-text-main">No upstream targets configured</span>
          <span className="text-[11px] text-text-muted">Connect a provider to map gateway ingress to upstream routes.</span>
        </div>
      ) : viewMode === "paths" ? (
        <div className="p-4 flex-1 overflow-y-auto custom-scrollbar max-h-[430px] divide-y divide-border-subtle">
          {allTargets.map((t) => (
            <div key={t.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <ProviderMark providerId={t.id} label={t.label} textIcon={t.textIcon} color={t.color} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-text-main truncate">{t.label}</span>
                    {t.active && (
                      <span className="rounded px-1.5 py-0.2 bg-[#a6c23f]/20 text-[10px] font-mono font-semibold text-[#5b6f10] dark:text-[#a6c23f]">
                        ACTIVE
                      </span>
                    )}
                    {t.error && (
                      <span className="rounded px-1.5 py-0.2 bg-red-600/15 text-[10px] font-mono font-semibold text-[#dc2626]">
                        ERR
                      </span>
                    )}
                    {!t.hasConnection && t.requests === 0 && (
                      <span className="rounded border border-border px-1.5 text-[10px] text-text-muted">
                        Standby
                      </span>
                    )}
                  </div>
                  <div className="mt-1 h-1 w-32 sm:w-44 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.max(t.requests > 0 ? 4 : 0, t.sharePct)}%`,
                        backgroundColor: t.active ? "#a6c23f" : t.error ? "#dc2626" : "var(--color-text-main)",
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 text-right font-mono text-xs tabular-nums shrink-0">
                <div>
                  <div className="font-semibold text-text-main">{fmtCompact(t.requests)} req</div>
                  <div className="text-[10px] text-text-muted">{t.sharePct}% share</div>
                </div>
                <div className="hidden sm:block w-20">
                  <div className="text-text-main">{fmtCompact(t.tokens)} tok</div>
                  <div className="text-[10px] text-text-muted">${t.cost.toFixed(3)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col flex-1 justify-between">
          {/* 3-Stage Directed Gateway Flow Map */}
          <div ref={canvasRef} className="relative px-4 py-5 flex-1 flex items-center">
            {/* Dynamic SVG Bus Connectors (md+) */}
            {busPaths.width > 0 && (
              <svg
                className="pointer-events-none absolute inset-0 hidden md:block"
                width={busPaths.width}
                height={busPaths.height}
                viewBox={`0 0 ${busPaths.width} ${busPaths.height}`}
              >
                {busPaths.left.map((edge) => (
                  <g key={edge.id}>
                    <path
                      d={edge.d}
                      fill="none"
                      stroke={edge.active ? "#a6c23f" : edge.hasTraffic ? "var(--color-text-muted)" : "var(--color-border-strong)"}
                      strokeWidth={edge.active ? 2 : edge.hasTraffic ? 1.5 : 1}
                      strokeDasharray={edge.active ? "6 5" : edge.hasTraffic ? undefined : "3 4"}
                      className={edge.active ? "mono-flow-dash" : undefined}
                      strokeLinecap="round"
                    />
                  </g>
                ))}
                {busPaths.right.map(({ id, d, target }) => {
                  const stroke = target.error
                    ? "#dc2626"
                    : target.active
                      ? "#a6c23f"
                      : target.last
                        ? "var(--color-text-main)"
                        : target.requests > 0
                          ? "var(--color-text-muted)"
                          : "var(--color-border)";
                  const strokeWidth = target.active || target.error
                    ? 2.2
                    : target.last
                      ? 1.8
                      : target.requests > 0
                        ? Math.min(2.2, 1.15 + target.sharePct / 70)
                        : 1;
                  const dashed = !target.active && !target.last && !target.error && target.requests === 0;
                  return (
                    <path
                      key={id}
                      d={d}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      strokeDasharray={target.active ? "6 5" : dashed ? "3 4" : undefined}
                      className={target.active ? "mono-flow-dash" : undefined}
                      strokeLinecap="round"
                    />
                  );
                })}
              </svg>
            )}

            {/* Grid Columns: Ingress -> Core -> Upstreams */}
            <div className="relative z-10 w-full grid grid-cols-1 md:grid-cols-[minmax(150px,1.05fr)_minmax(175px,0.95fr)_minmax(210px,1.4fr)] gap-4 md:gap-8 items-center">
              {/* Stage 1: Ingress Channels */}
              <div className="flex flex-col gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-0.5">
                  Ingress ({ingressNodes.length})
                </span>
                {ingressNodes.map((node, i) => (
                  <div
                    key={node.endpoint}
                    className="relative flex items-center justify-between gap-2 rounded-xl border border-border bg-bg-alt/60 px-3 py-2 text-xs min-w-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn("size-1.5 rounded-full shrink-0", node.requests > 0 ? "bg-[#a6c23f]" : "bg-text-subtle")} />
                      <code className="font-mono text-[11px] font-medium text-text-main truncate" title={node.endpoint}>
                        {node.endpoint}
                      </code>
                    </div>
                    <span className="font-mono text-[11px] text-text-muted tabular-nums shrink-0">
                      {fmtCompact(node.requests)}
                    </span>
                    <span
                      ref={(el) => { ingressPortRefs.current[i] = el; }}
                      className={cn(
                        "hidden md:block absolute -right-1.5 top-1/2 -translate-y-1/2 size-2.5 rounded-full border-2 border-surface",
                        node.requests > 0 ? "bg-text-main" : "bg-border-strong"
                      )}
                    />
                  </div>
                ))}
              </div>

              {/* Stage 2: 888router Policy Core Switch */}
              <div className="flex flex-col items-center justify-center min-w-0">
                <div className="relative w-full max-w-[220px] rounded-2xl bg-[#111111] text-white dark:bg-[#fafafa] dark:text-[#111111] px-4 py-3.5 shadow-[0_6px_20px_rgba(0,0,0,0.12)] border border-[#222222] dark:border-[#e5e5e5]">
                  {/* Core Anchor Ports */}
                  <span
                    ref={coreInPortRef}
                    className="hidden md:block absolute -left-1.5 top-1/2 -translate-y-1/2 size-3 rounded-full bg-[#a6c23f] border-2 border-surface"
                  />
                  <span
                    ref={coreOutPortRef}
                    className="hidden md:block absolute -right-1.5 top-1/2 -translate-y-1/2 size-3 rounded-full bg-[#a6c23f] border-2 border-surface"
                  />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center size-6 rounded-md bg-white/15 dark:bg-black/10 font-mono text-[10px] font-bold">
                        888
                      </span>
                      <div>
                        <div className="text-xs font-semibold leading-tight">Policy Core</div>
                        <div className="text-[10px] opacity-65 font-mono">888router</div>
                      </div>
                    </div>
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold",
                        activeTotalCount > 0
                          ? "bg-[#a6c23f] text-[#111111]"
                          : "bg-white/12 text-white/80 dark:bg-black/10 dark:text-black/75"
                      )}
                    >
                      {activeTotalCount > 0 ? `${activeTotalCount} live` : "Ready"}
                    </span>
                  </div>

                  <div className="mt-3 pt-2.5 border-t border-white/15 dark:border-black/10 grid grid-cols-2 gap-2 text-[10px] font-mono tabular-nums">
                    <div>
                      <div className="opacity-65 uppercase">Routed</div>
                      <div className="text-xs font-semibold">{fmtCompact(computedTotalRequests)}</div>
                    </div>
                    <div className="text-right">
                      <div className="opacity-65 uppercase">Cached</div>
                      <div className="text-xs font-semibold">{cacheHitPct}%</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Stage 3: Upstream Targets */}
              <div className="flex flex-col gap-2 min-w-0">
                <div className="flex items-center justify-between px-0.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                    Upstreams ({visibleTargets.length})
                  </span>
                  <span className="text-[10px] font-mono text-text-subtle">Click node to inspect</span>
                </div>

                {visibleTargets.map((target, i) => {
                  const isSelected = selectedTarget?.id === target.id;
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => setSelectedProviderId((cur) => (cur === target.id ? null : target.id))}
                      className={cn(
                        "relative w-full text-left flex items-center justify-between gap-2.5 rounded-xl border px-3 py-2 transition-colors overflow-hidden cursor-pointer bg-surface hover:bg-bg-alt/70",
                        isSelected
                          ? "border-text-main ring-1 ring-text-main/15"
                          : target.active
                            ? "border-[#a6c23f]"
                            : target.error
                              ? "border-[#dc2626]/60"
                              : "border-border"
                      )}
                    >
                      {/* Target Anchor Port */}
                      <span
                        ref={(el) => { targetPortRefs.current[i] = el; }}
                        className={cn(
                          "hidden md:block absolute -left-1.5 top-1/2 -translate-y-1/2 size-2.5 rounded-full border-2 border-surface",
                          target.active || target.last
                            ? "bg-[#a6c23f]"
                            : target.error
                              ? "bg-[#dc2626]"
                              : "bg-border-strong"
                        )}
                      />

                      <div className="flex items-center gap-2.5 min-w-0">
                        <ProviderMark
                          providerId={target.id}
                          label={target.label}
                          textIcon={target.textIcon}
                          color={target.color}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-text-main truncate">{target.label}</span>
                            {target.active && (
                              <span className="size-1.5 rounded-full bg-[#a6c23f] shrink-0" title="In-flight" />
                            )}
                            {target.last && !target.active && (
                              <span className="rounded border border-border px-1 text-[9px] font-mono uppercase text-text-muted">
                                Last
                              </span>
                            )}
                            {target.error && (
                              <span className="rounded bg-red-600/15 px-1 text-[9px] font-mono uppercase font-semibold text-[#dc2626]">
                                Err
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-text-muted tabular-nums">
                            {target.tokens > 0 ? `${fmtCompact(target.tokens)} tok` : target.hasConnection ? "Connected" : "Standby"}
                          </div>
                        </div>
                      </div>

                      <div className="text-right font-mono tabular-nums shrink-0">
                        <div className="text-xs font-semibold text-text-main">
                          {target.requests > 0 ? `${fmtCompact(target.requests)}` : "—"}
                        </div>
                        <div className="text-[10px] text-text-muted">
                          {target.requests > 0 ? `${target.sharePct}%` : "0%"}
                        </div>
                      </div>

                      {/* Proportional traffic share baseline */}
                      {target.sharePct > 0 && (
                        <span
                          className="absolute bottom-0 left-0 h-[2px] transition-all"
                          style={{
                            width: `${Math.max(4, target.sharePct)}%`,
                            backgroundColor: target.active ? "#a6c23f" : target.error ? "#dc2626" : "var(--color-text-main)",
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Inline Micro-Inspector or Standby Pool Bar */}
          {(selectedTarget || standbyTargets.length > 0) && (
            <div className="border-t border-border bg-bg-alt px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              {selectedTarget ? (
                <div className="flex flex-wrap items-center justify-between gap-2 w-full">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-semibold text-text-main">{selectedTarget.label}</span>
                    <span className="font-mono text-[11px] text-text-muted tabular-nums">
                      {fmtCompact(selectedTarget.requests)} req · {fmtCompact(selectedTarget.tokens)} tok · ${selectedTarget.cost.toFixed(4)}
                    </span>
                    {selectedModels.slice(0, 2).map((m) => (
                      <code key={m.name} className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-main">
                        {m.name} ({m.requests})
                      </code>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link href="/dashboard/providers" className="text-[11px] font-medium text-text-main hover:underline">
                      Configure →
                    </Link>
                    <button
                      type="button"
                      onClick={() => setSelectedProviderId(null)}
                      className="text-[11px] text-text-muted hover:text-text-main cursor-pointer"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 w-full">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-text-muted">Standby free pools ({standbyTargets.length}):</span>
                    {standbyTargets.slice(0, 4).map((s) => (
                      <span key={s.id} className="rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] text-text-muted">
                        {s.label}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowStandby((v) => !v)}
                    className="text-[11px] font-medium text-text-main hover:underline cursor-pointer shrink-0"
                  >
                    {showStandby ? "Hide standby" : "Include in graph"}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      provider: PropTypes.string,
      name: PropTypes.string,
    })
  ),
  activeRequests: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string,
      model: PropTypes.string,
      account: PropTypes.string,
    })
  ),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
  byProvider: PropTypes.object,
  byModel: PropTypes.object,
  byEndpoint: PropTypes.object,
  totalRequests: PropTypes.number,
  totalPromptTokens: PropTypes.number,
  totalCachedTokens: PropTypes.number,
};
