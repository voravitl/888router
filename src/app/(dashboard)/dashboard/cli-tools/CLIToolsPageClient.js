"use client";

import { useState, useEffect, useMemo } from "react";
import { CardSkeleton, PageHero } from "@/shared/components";
import { CLI_TOOLS, MITM_TOOLS } from "@/shared/constants/cliTools";
import { ApiOutlined } from "@ant-design/icons";
import { MitmLinkCard } from "./components";
import ToolSummaryCard from "./components/ToolSummaryCard";

const ALL_STATUSES_URL = "/api/cli-tools/all-statuses";

export default function CLIToolsPageClient({ machineId }) {
  const [loading, setLoading] = useState(true);
  const [toolStatuses, setToolStatuses] = useState({});

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(ALL_STATUSES_URL);
        if (res.ok && mounted) setToolStatuses(await res.json());
      } catch (error) {
        console.log("Error fetching tool statuses:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const configuredCount = useMemo(
    () => Object.values(toolStatuses || {}).filter((s) => s?.configured || s?.installed).length,
    [toolStatuses]
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const regularTools = Object.entries(CLI_TOOLS);
  const mitmTools = Object.entries(MITM_TOOLS);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-1 sm:px-0">
      <PageHero
        eyebrow="CLIENT INTEGRATIONS · AGENT & CLI PROVISIONING"
        title="CLI & IDE Connectors"
        description="One-click endpoint configuration, environment variable generation, and TLS interception bridges for developer agents."
        icon={<ApiOutlined />}
        accent="cyan"
        badge={{
          label: `${regularTools.length + mitmTools.length} INTEGRATIONS`,
          color: "cyan",
          pulse: true,
        }}
        stats={[
          { label: "CLI Connectors", value: regularTools.length, color: "#06b6d4" },
          { label: "Configured", value: configuredCount, color: "#10b981" },
          { label: "MITM Bridges", value: mitmTools.length, color: "#f59e0b" },
          { label: "Target Host", value: machineId ? String(machineId).slice(0, 10) : "LOCAL", color: "#a855f7" },
        ]}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {regularTools.map(([toolId, tool]) => (
          <ToolSummaryCard key={toolId} toolId={toolId} tool={tool} status={toolStatuses[toolId]} />
        ))}
      </div>

      <div className="hyperion-card rounded-2xl border border-amber-500/25 p-4 sm:p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="size-8 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[18px]">security</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-main">MITM Traffic Interception Circuit</h2>
              <p className="text-[11px] text-text-muted">Route closed-source desktop clients transparently through your 888router node.</p>
            </div>
          </div>
          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-400">
            {mitmTools.length} BRIDGES
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {mitmTools.map(([toolId, tool]) => (
            <MitmLinkCard key={toolId} tool={tool} />
          ))}
        </div>
      </div>
    </div>
  );
}
