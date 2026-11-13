"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Segmented } from "antd";
import { UsageStats, RequestLogger } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";
import OptimizationSavings from "./components/OptimizationSavings";
import { cn } from "@/shared/utils/cn";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24H" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const TAB_ITEMS = [
  { label: "Overview", value: "overview" },
  { label: "Live Traces", value: "logs" },
  { label: "Request Details", value: "details" },
  { label: "Token Savings", value: "savings" },
];

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [period, setPeriod] = useState("7d");
  const urlTab = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState(
    ["overview", "logs", "details", "savings"].includes(urlTab) ? urlTab : "overview"
  );

  useEffect(() => {
    const t = searchParams.get("tab");
    if (["overview", "logs", "details", "savings"].includes(t)) {
      setActiveTab(t);
    }
  }, [searchParams]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const showPeriodBar = activeTab === "overview" || activeTab === "savings";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* Slim Monochrome Command Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="flex flex-wrap items-center gap-3 min-w-0 max-w-full">
          <h1 className="text-sm font-semibold tracking-tight text-text-main m-0 shrink-0">
            Usage & Live Traces
          </h1>
          <div className="max-w-full overflow-x-auto custom-scrollbar">
            <Segmented
              size="small"
              value={activeTab}
              onChange={handleTabChange}
              options={TAB_ITEMS}
            />
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="hidden sm:flex items-center gap-1.5 rounded-lg border border-border bg-bg-alt px-2.5 py-1 text-[11px] font-medium text-text-main">
            <span className="size-1.5 rounded-full bg-[#a6c23f] inline-block" />
            <span>Live SSE</span>
          </div>

          {showPeriodBar && (
            <div className="inline-flex rounded-lg border border-border bg-bg-alt p-0.5" role="group" aria-label="Time window">
              {PERIODS.map((p) => (
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
          )}
        </div>
      </div>

      {activeTab === "overview" && (
        <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
      )}
      {activeTab === "savings" && <OptimizationSavings period={period} />}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}

export default function UsagePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12 font-mono text-xs text-text-muted">
          LOADING TELEMETRY...
        </div>
      }
    >
      <UsageContent />
    </Suspense>
  );
}
