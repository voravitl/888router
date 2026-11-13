"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Drawer, Input } from "antd";
import { cn } from "@/shared/utils/cn";

export default function RequestLogger() {
  const [logs, setLogs] = useState([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedRow, setSelectedRow] = useState(null);
  const intervalRef = useRef(null);

  const fetchLogs = async () => {
    try {
      const response = await fetch("/api/usage/request-logs");
      if (response.ok) {
        const text = await response.text();
        const lines = text.trim().split("\n").filter((line) => line.length > 0);
        setLogs(lines);
      }
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    }
  };

  useEffect(() => {
    fetchLogs();
    if (!paused) {
      intervalRef.current = setInterval(fetchLogs, 3000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [paused]);

  const parsedRows = useMemo(() => {
    return logs.map((line, index) => {
      const parts = line.split(" | ");
      if (parts.length < 7) {
        return {
          key: `raw-${index}`,
          raw: line,
          datetime: "",
          model: line,
          provider: "—",
          account: "—",
          inTokens: "—",
          outTokens: "—",
          status: "RAW",
          statusCode: null,
        };
      }
      const [datetime, model, provider, account, sentStr, receivedStr, status] = parts;
      const inTokens = sentStr?.replace("in:", "").trim() || "0";
      const outTokens = receivedStr?.replace("out:", "").trim() || "0";
      const statusCodeMatch = String(status || "").match(/\d{3}/);
      return {
        key: `${datetime}-${model}-${index}`,
        raw: line,
        datetime,
        model,
        provider: provider?.toUpperCase() || "—",
        account,
        inTokens,
        outTokens,
        status: status?.trim() || "—",
        statusCode: statusCodeMatch ? Number(statusCodeMatch[0]) : null,
      };
    });
  }, [logs]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return parsedRows;
    return parsedRows.filter((row) => row.raw.toLowerCase().includes(q));
  }, [parsedRows, query]);

  const statusColor = (status, code) => {
    if (String(status).includes("200") || String(status).toUpperCase().includes("OK")) {
      return "text-emerald-700 dark:text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    }
    if (code === 429 || String(status).includes("429")) {
      return "text-amber-700 dark:text-amber-400 border-amber-500/30 bg-amber-500/10";
    }
    return "text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/10";
  };

  return (
    <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)] flex flex-col overflow-hidden">
      {/* Hairline Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-bg-alt">
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("size-2 rounded-full inline-block", paused ? "bg-amber-500" : "bg-[#a6c23f]")} />
          <span className="font-semibold text-text-main">
            Live Trace Stream
          </span>
          <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text-muted tabular-nums">
            {filteredRows.length}/{parsedRows.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter model, provider, status..."
            allowClear
            className="!w-56 !text-xs"
          />
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="px-2.5 h-7 rounded-lg border border-border bg-surface hover:bg-surface-2 text-xs font-medium text-text-main transition-colors cursor-pointer"
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={fetchLogs}
            className="px-2.5 h-7 rounded-lg border border-border bg-surface hover:bg-surface-2 text-xs font-medium text-text-muted hover:text-text-main transition-colors cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Dense Monochrome Table */}
      <div className="overflow-x-auto max-h-[600px] overflow-y-auto custom-scrollbar">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-bg-alt border-b border-border text-[11px] font-medium text-text-muted z-10">
            <tr>
              <th className="text-left px-4 py-2.5">Timestamp</th>
              <th className="text-left px-4 py-2.5">Model</th>
              <th className="text-left px-4 py-2.5">Provider</th>
              <th className="text-left px-4 py-2.5">Account</th>
              <th className="text-right px-4 py-2.5">In</th>
              <th className="text-right px-4 py-2.5">Out</th>
              <th className="text-right px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-text-muted">
                  No live log events match filter.
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <tr
                  key={row.key}
                  onClick={() => setSelectedRow(row)}
                  className="cursor-pointer hover:bg-surface-2/60 transition-colors"
                >
                  <td className="px-4 py-2 font-mono text-[11px] text-text-muted whitespace-nowrap">{row.datetime || "—"}</td>
                  <td className="px-4 py-2 font-medium text-text-main max-w-[260px] truncate">{row.model}</td>
                  <td className="px-4 py-2 text-text-muted whitespace-nowrap">{row.provider}</td>
                  <td className="px-4 py-2 text-text-muted max-w-[180px] truncate">{row.account}</td>
                  <td className="px-4 py-2 text-right font-mono text-text-main">{row.inTokens}</td>
                  <td className="px-4 py-2 text-right font-mono text-text-muted">{row.outTokens}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <span className={cn("inline-block px-2 py-0.5 rounded-md border text-[11px] font-medium", statusColor(row.status, row.statusCode))}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* AntD Drawer for quick log line inspection */}
      <Drawer
        open={Boolean(selectedRow)}
        onClose={() => setSelectedRow(null)}
        title="Live Trace Entry"
        size="default"
        destroyOnHidden
        mask={{ blur: false }}
      >
        {selectedRow && (
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-border divide-y divide-border-subtle overflow-hidden">
              {[
                ["Timestamp", selectedRow.datetime],
                ["Model", selectedRow.model],
                ["Provider", selectedRow.provider],
                ["Account", selectedRow.account],
                ["Tokens (In / Out)", `${selectedRow.inTokens} / ${selectedRow.outTokens}`],
                ["Status", selectedRow.status],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <span className="text-text-muted">{k}</span>
                  <span className="font-mono text-text-main font-medium text-right break-all">{v || "—"}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[11px] font-medium text-text-muted mb-1.5">
                Raw Record
              </div>
              <pre className="p-3.5 rounded-xl border border-border bg-bg-alt font-mono text-[11px] whitespace-pre-wrap break-all">
                {selectedRow.raw}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
