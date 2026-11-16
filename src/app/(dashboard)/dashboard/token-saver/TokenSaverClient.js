"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { Card, Button, Toggle, PageHero } from "@/shared/components";
import { ThunderboltOutlined } from "@ant-design/icons";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Math.abs(Number(n));
  if (v < 1024) return `${Math.round(n)} B`;
  if (v < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString();
}

function fmtChartBytes(n) {
  if (n == null || Number.isNaN(n)) return "0";
  const v = Math.abs(Number(n));
  if (v < 1024) return `${Math.round(n)}`;
  if (v < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [prunerEnabled, setPrunerEnabled] = useState(true);
  const [locale, setLocale] = useState("en");
  const [summaryPeriod, setSummaryPeriod] = useState("7d");
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      setCavemanLevel("ultra");
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, cavemanLevel]);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  const loadSummary = useCallback(async (period = summaryPeriod) => {
    setSummaryLoading(true);
    setSummaryError("");
    try {
      const res = await fetch(`/api/usage/token-save-summary?period=${period}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load summary");
      setSummary(data);
    } catch (e) {
      setSummaryError(e.message || "Failed to load summary");
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, [summaryPeriod]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          setPrunerEnabled(data.prunerEnabled !== false);
        }
      } catch {}
    };
    loadSettings();
  }, []);

  useEffect(() => {
    loadSummary(summaryPeriod);
  }, [summaryPeriod, loadSummary]);

  const rtk = summary?.rtk;

  const beforeAfterChart = useMemo(() => {
    if (!rtk) return [];
    return [
      { name: "Before", bytes: rtk.bytesBefore || 0, fill: "#94a3b8" },
      { name: "After", bytes: rtk.bytesAfter || 0, fill: "#6366f1" },
      { name: "Saved", bytes: rtk.bytesSaved || 0, fill: "#22c55e" },
    ];
  }, [rtk]);

  const filterChart = useMemo(() => {
    const list = rtk?.topFilters || [];
    return list.slice(0, 8).map((f) => ({ name: f.name, hits: f.count }));
  }, [rtk]);

  const daySeries = useMemo(() => {
    return (summary?.series || []).map((d) => ({
      ...d,
      label: d.date?.slice(5) || d.date, // MM-DD
    }));
  }, [summary]);

  const pct = rtk?.pctSaved ?? 0;
  const keptPct = Math.max(0, 100 - pct);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHero
        eyebrow="RTK STREAM OPTIMIZER · BANDWIDTH & CONTEXT SAVER"
        title="Token Saver Studio"
        description="Measure before/after prompt payload compression across live tool outputs and configure compact response dialects."
        icon={<ThunderboltOutlined />}
        accent="emerald"
        badge={{
          label: `${pct}% PAYLOAD SAVED (${summaryPeriod.toUpperCase()})`,
          color: "green",
          pulse: pct > 0,
        }}
        stats={[
          { label: "Saved Ratio", value: `${pct}%`, color: "#10b981" },
          { label: "Before Output", value: fmtBytes(rtk?.bytesBefore), color: "#94a3b8" },
          { label: "After Output", value: fmtBytes(rtk?.bytesAfter), color: "#06b6d4" },
          { label: "Bytes Saved", value: fmtBytes(rtk?.bytesSaved), color: "#f59e0b" },
        ]}
      />

      {/* Aggregated before/after savings — primary reason this page is in the sidebar */}
      <Card id="savings-report" className="border border-border bg-surface">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">monitoring</span>
              Savings report
            </h2>
            <p className="text-sm text-text-muted mt-1">
              RTK tool output only (not full bill) — before → after from real requests
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {["24h", "7d", "30d"].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSummaryPeriod(p)}
                className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                  summaryPeriod === p
                    ? "bg-primary text-white border-primary"
                    : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                }`}
              >
                {p}
              </button>
            ))}
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => loadSummary(summaryPeriod)} disabled={summaryLoading}>
              Refresh
            </Button>
          </div>
        </div>

        {summaryError ? (
          <p className="text-sm text-warning mb-3">{summaryError}</p>
        ) : null}

        {summaryLoading && !summary ? (
          <p className="text-sm text-text-muted">Loading savings…</p>
        ) : (
          <>
            {/* Big visual: what % was cut */}
            <div className="mb-5 rounded-xl border border-border bg-surface-2/30 p-4">
              <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-text-muted">Tool blobs after RTK</p>
                  <p className="text-3xl font-semibold text-success mt-0.5">−{pct}%</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-mono text-text-muted">
                    {fmtBytes(rtk?.bytesBefore)} → {fmtBytes(rtk?.bytesAfter)}
                  </p>
                  <p className="text-success">saved {fmtBytes(rtk?.bytesSaved)}</p>
                </div>
              </div>
              <div className="h-8 w-full rounded-full overflow-hidden flex bg-black/10 dark:bg-white/10">
                <div
                  className="h-full bg-indigo-500/90 flex items-center justify-center text-[11px] font-medium text-white transition-all"
                  style={{ width: `${keptPct}%` }}
                  title="Still sent (after)"
                >
                  {keptPct >= 18 ? `kept ${keptPct}%` : ""}
                </div>
                <div
                  className="h-full bg-emerald-500 flex items-center justify-center text-[11px] font-medium text-white transition-all"
                  style={{ width: `${pct}%` }}
                  title="Removed by RTK"
                >
                  {pct >= 12 ? `−${pct}%` : ""}
                </div>
              </div>
              <p className="text-[11px] text-text-muted mt-2">
                Purple = still sent · Green = cut by RTK · {fmtNum(summary?.period?.scanned)} requests · {summary?.periodLabel || summaryPeriod}
              </p>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
              <div className="rounded-xl border border-border p-3 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                  Before vs After vs Saved
                </p>
                {(rtk?.bytesBefore || 0) > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={beforeAfterChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tickFormatter={fmtChartBytes} tick={{ fontSize: 11 }} width={40} />
                      <Tooltip
                        formatter={(v) => fmtBytes(v)}
                        contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-main)" }}
                        labelStyle={{ color: "var(--color-text-muted)", fontWeight: 600 }}
                        itemStyle={{ color: "var(--color-text-main)" }}
                      />
                      <Bar dataKey="bytes" name="Size" radius={[6, 6, 0, 0]}>
                        {beforeAfterChart.map((entry) => (
                          <Cell key={entry.name} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-text-muted">No RTK data</div>
                )}
              </div>

              <div className="rounded-xl border border-border p-3 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                  Saved per day
                </p>
                {daySeries.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={daySeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gradSaved" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22c55e" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tickFormatter={fmtChartBytes} tick={{ fontSize: 11 }} width={40} />
                      <Tooltip
                        formatter={(v, name) => [fmtBytes(v), name === "saved" ? "Saved" : name]}
                        labelFormatter={(_, payload) => payload?.[0]?.payload?.date || ""}
                        contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-main)" }}
                        labelStyle={{ color: "var(--color-text-muted)", fontWeight: 600 }}
                        itemStyle={{ color: "var(--color-text-main)" }}
                      />
                      <Area
                        type="monotone"
                        dataKey="saved"
                        name="Saved"
                        stroke="#22c55e"
                        fill="url(#gradSaved)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-text-muted">No daily series yet</div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
              <div className="rounded-xl border border-border p-3 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                  Top filters (hits)
                </p>
                {filterChart.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      data={filterChart}
                      layout="vertical"
                      margin={{ top: 4, right: 12, left: 8, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ fontSize: 12, borderRadius: 8, backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text-main)" }}
                        labelStyle={{ color: "var(--color-text-muted)", fontWeight: 600 }}
                        itemStyle={{ color: "var(--color-text-main)" }}
                      />
                      <Bar dataKey="hits" name="Hits" fill="#6366f1" radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-sm text-text-muted">No filter hits</div>
                )}
              </div>

              <div className="rounded-xl border border-border p-3 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">
                  Snapshot
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="rounded-lg bg-surface-2/40 p-3">
                    <p className="text-[10px] uppercase text-text-muted">Scanned</p>
                    <p className="text-xl font-semibold">{fmtNum(summary?.period?.scanned)}</p>
                  </div>
                  <div className="rounded-lg bg-surface-2/40 p-3">
                    <p className="text-[10px] uppercase text-text-muted">Context Pruner</p>
                    <p className="text-xl font-semibold">
                      −{fmtNum(summary?.pruner?.tokensSaved || 0)} <span className="text-sm font-normal text-text-muted">tok</span>
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2/40 p-3">
                    <p className="text-[10px] uppercase text-text-muted">RTK Saved Requests</p>
                    <p className="text-xl font-semibold">
                      {fmtNum(rtk?.requestsWithSavings)}
                      <span className="text-sm font-normal text-text-muted"> / {fmtNum(rtk?.requestsWithStats)}</span>
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-lg border border-border/40 bg-surface-2/20 p-2.5 text-[11px] text-text-muted leading-4">
                  💡 <strong>Dual-Average Note:</strong> Overall % reflects total window (short + long chats). Heavy requests with large tool outputs or long context yield <strong>60–90% reduction</strong> on active pruning/RTK.
                </div>
                {summary?.recent?.length ? (
                  <ul className="mt-3 space-y-1.5 max-h-36 overflow-y-auto custom-scrollbar">
                    {summary.recent.slice(0, 6).map((row, idx) => (
                      <li key={row.id || idx} className="text-xs flex justify-between gap-2 border-b border-border/50 pb-1">
                        <span className="font-mono truncate">{row.model || "—"}</span>
                        <span className="text-success shrink-0">
                          {row.rtkBytesSaved > 0 ? `−${fmtBytes(row.rtkBytesSaved)}` : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-text-muted mt-3">No recent savings rows.</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-3 text-sm">
              <Link href="/dashboard/usage" className="text-primary underline hover:opacity-80">
                Open Usage → Request Details (per-request benchmark)
              </Link>
              <Link href="/dashboard/basic-chat" className="text-primary underline hover:opacity-80">
                Test Chat (meta under replies)
              </Link>
            </div>
          </>
        )}
      </Card>

      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Controls
          </h2>
        </div>
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>
        {/* Pruner toggle */}
        <div className="flex items-center justify-between py-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Prune history{" "}
              <span className="text-xs font-normal text-text-muted">
                (Context Pruner)
              </span>
            </p>
            <p className="text-sm text-text-muted">
              Drop middle conversation turns when context exceeds model budget
            </p>
          </div>
          <Toggle
            checked={prunerEnabled}
            onChange={() => {
              const next = !prunerEnabled;
              setPrunerEnabled(next);
              patchSetting({ prunerEnabled: next });
            }}
          />
        </div>
        <div className="flex items-center justify-between pt-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Bias the model toward minimal code: does it need to exist at all,
              then reuse the codebase, then stdlib — deletion over addition
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
