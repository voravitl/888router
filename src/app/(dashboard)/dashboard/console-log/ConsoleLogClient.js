"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, PageHero } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { FileTextOutlined } from "@ant-design/icons";

const LOG_LEVEL_COLORS = {
  LOG: "text-green-400",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-purple-400",
};

function colorLine(line) {
  const match = line.match(/\[(\w+)\]/g);
  const levelTag = match ? match[1]?.replace(/\[|\]/g, "") : null;
  const color = LOG_LEVEL_COLORS[levelTag] || "text-green-400";
  return <span className={color}>{line}</span>;
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const logRef = useRef(null);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "init") {
        setLogs(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        setLogs((prev) => {
          const next = [...prev, msg.line];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "lines") {
        setLogs((prev) => {
          const next = [...prev, ...msg.lines];
          return next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next;
        });
      } else if (msg.type === "clear") {
        setLogs([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard?.writeText(logs.join("\n"));
    } catch {
      // ignore clipboard restrictions
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        eyebrow="LIVE TRANSLATOR STREAM · SSE CONSOLE"
        title="System Console Stream"
        description="Real-time proxy translator, failover, and upstream execution logs streamed live via Server-Sent Events."
        icon={<FileTextOutlined />}
        accent={connected ? "emerald" : "amber"}
        badge={{
          label: connected ? "SSE STREAM LIVE" : "RECONNECTING...",
          color: connected ? "green" : "amber",
          pulse: connected,
        }}
        stats={[
          { label: "Stream State", value: connected ? "LIVE" : "WAIT", color: connected ? "#10b981" : "#f59e0b" },
          { label: "Buffered Lines", value: logs.length, color: "#06b6d4" },
          { label: "Ring Buffer Cap", value: CONSOLE_LOG_CONFIG.maxLines, color: "#a855f7" },
          { label: "Transport", value: "SSE", color: "#38bdf8" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" icon="content_copy" onClick={handleCopyAll} disabled={logs.length === 0}>
              Copy Logs
            </Button>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
              Clear
            </Button>
          </div>
        }
      />

      <Card padding="none" className="hyperion-card overflow-hidden border border-border/70">
        <div className="flex items-center justify-between border-b border-border/70 bg-black/40 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-rose-500/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
            <span className="ml-2 font-mono text-[11px] text-text-muted">/api/translator/console-logs/stream</span>
          </div>
          <span className="font-mono text-[11px] text-cyan-400">{logs.length} / {CONSOLE_LOG_CONFIG.maxLines} lines</span>
        </div>
        <div
          ref={logRef}
          className="bg-[#05080f] p-4 text-xs font-mono h-[calc(100vh-340px)] min-h-[360px] overflow-y-auto leading-relaxed"
        >
          {logs.length === 0 ? (
            <span className="text-text-muted">Waiting for live translator or proxy console output...</span>
          ) : (
            <div className="space-y-0.5">
              {logs.map((line, i) => (
                <div key={i}>{colorLine(line)}</div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
