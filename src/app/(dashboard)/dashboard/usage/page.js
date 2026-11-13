"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, PageHero } from "@/shared/components";
import { Segmented } from "antd";
import { RadarChartOutlined } from "@ant-design/icons";
import RequestDetailsTab from "./components/RequestDetailsTab";
import OptimizationSavings from "./components/OptimizationSavings";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("7d");

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details", "savings"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <PageHero
        eyebrow="TELEMETRY & COST OBSERVATORY · LIVE STREAM"
        title="Usage & Analytics Cockpit"
        description="Real-time token burn, latency topology, model cost attribution, optimization savings, and full request audit inspection."
        icon={<RadarChartOutlined />}
        accent="amber"
        badge={{
          label: `WINDOW: ${period.toUpperCase()}`,
          color: "amber",
          pulse: true,
        }}
        toolbar={
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="overflow-x-auto">
              <Segmented
                size="small"
                value={activeTab}
                onChange={handleTabChange}
                options={[
                  { value: "overview", label: "Overview" },
                  { value: "savings", label: "Savings" },
                  { value: "details", label: "Request Details" },
                  { value: "logs", label: "Request Logs" },
                ]}
              />
            </div>
            {(activeTab === "overview" || activeTab === "savings") && (
              <div className="overflow-x-auto">
                <Segmented
                  size="small"
                  value={period}
                  onChange={setPeriod}
                  options={PERIODS}
                />
              </div>
            )}
          </div>
        }
      />

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
        </Suspense>
      )}
      {activeTab === "savings" && (
        <Suspense fallback={<CardSkeleton />}>
          <OptimizationSavings period={period} />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
