"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Input } from "antd";
import { cn } from "@/shared/utils/cn";
import { useTheme } from "@/shared/hooks/useTheme";

const CATALOG_ROUTES = [
  { code: "888-01", label: "Usage & Live Traces", group: "TELEMETRY", href: "/dashboard/usage", keywords: "logs telemetry analytics stats waterfall trace cost latency" },
  { code: "888-02", label: "Gateway & API Keys", group: "GATEWAY", href: "/dashboard/endpoint", keywords: "endpoint key curl sdk tailscale cloudflare tunnel" },
  { code: "888-03", label: "Quota Tracker", group: "TELEMETRY", href: "/dashboard/quota", keywords: "limits quota usage budget cap" },
  { code: "888-04", label: "Token Savings", group: "TELEMETRY", href: "/dashboard/token-saver", keywords: "rtk headroom caveman ponytail compression save" },
  { code: "888-05", label: "Providers & Connections", group: "ROUTING", href: "/dashboard/providers", keywords: "openai anthropic gemini claude codex oauth apikey matrix" },
  { code: "888-06", label: "Combos & Fallbacks", group: "ROUTING", href: "/dashboard/combos", keywords: "combo fallback round robin pipeline locks" },
  { code: "888-07", label: "Test Chat Playground", group: "TOOLS", href: "/dashboard/basic-chat", keywords: "chat test prompt model" },
  { code: "888-08", label: "CLI Tools Sync", group: "TOOLS", href: "/dashboard/cli-tools", keywords: "claude codex cursor opencode cline" },
  { code: "888-09", label: "Web Fetch & Search", group: "MEDIA", href: "/dashboard/media-providers/web", keywords: "web search fetch media" },
  { code: "888-10", label: "Proxy Pools", group: "INFRA", href: "/dashboard/proxy-pools", keywords: "proxy socks http upstream" },
  { code: "888-11", label: "Agent Skills", group: "INFRA", href: "/dashboard/skills", keywords: "skills mcp" },
  { code: "888-12", label: "Console Log", group: "INFRA", href: "/dashboard/console-log", keywords: "console stdout debug" },
  { code: "888-13", label: "Settings & Profile", group: "SYSTEM", href: "/dashboard/profile", keywords: "settings theme password auth fallback" },
];

export default function CommandPalette({ open, onClose }) {
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dynamicItems, setDynamicItems] = useState([]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    let cancelled = false;
    Promise.allSettled([
      fetch("/api/providers").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/combos").then((r) => (r.ok ? r.json() : null)),
    ]).then(([provRes, comboRes]) => {
      if (cancelled) return;
      const extras = [];
      const conns = provRes.status === "fulfilled" ? provRes.value?.connections : null;
      if (Array.isArray(conns)) {
        const seenProviders = new Set();
        for (const c of conns) {
          if (!c?.provider || seenProviders.has(c.provider)) continue;
          seenProviders.add(c.provider);
          extras.push({
            code: "PRV",
            label: `${c.provider} (${c.name || "connection"})`,
            group: "CONNECTED PROVIDER",
            href: `/dashboard/providers/${c.provider}`,
            keywords: `${c.provider} ${c.name || ""} ${c.authType || ""}`,
          });
        }
      }
      const combos = comboRes.status === "fulfilled" ? comboRes.value?.combos : null;
      if (Array.isArray(combos)) {
        for (const combo of combos) {
          if (!combo?.name) continue;
          extras.push({
            code: "CMB",
            label: combo.name,
            group: "ACTIVE COMBO",
            href: `/dashboard/combos?selected=${encodeURIComponent(combo.name)}`,
            keywords: `${combo.name} ${combo.strategy || ""} combo`,
          });
        }
      }
      setDynamicItems(extras);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const items = useMemo(() => {
    const actionItem = {
      code: "SYS",
      label: isDark ? "Switch to Archival Paper (Light Theme)" : "Switch to Matte Obsidian (Dark Theme)",
      group: "ACTION",
      action: () => {
        toggleTheme();
        onClose();
      },
      keywords: "theme dark light mode toggle",
    };
    const pool = [...CATALOG_ROUTES, ...dynamicItems, actionItem];
    const q = query.trim().toLowerCase();
    if (!q) return pool.slice(0, 14);
    return pool
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.code.toLowerCase().includes(q) ||
          item.group.toLowerCase().includes(q) ||
          (item.keywords && item.keywords.toLowerCase().includes(q))
      )
      .slice(0, 16);
  }, [dynamicItems, isDark, onClose, query, toggleTheme]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = (item) => {
    if (!item) return;
    if (item.action) {
      item.action();
      return;
    }
    onClose();
    router.push(item.href);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length ? (prev - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter" && items[selectedIndex]) {
      e.preventDefault();
      handleSelect(items[selectedIndex]);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={620}
      destroyOnHidden
      mask={{ blur: false }}
      styles={{
        container: { padding: 0, borderRadius: 12, border: "1px solid var(--color-border)" },
        body: { padding: 0 },
      }}
    >
      <div className="bg-surface text-text-main rounded-xl overflow-hidden" onKeyDown={handleKeyDown}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-bg-alt">
          <span className="material-symbols-outlined text-[18px] text-text-muted shrink-0">
            search
          </span>
          <Input
            autoFocus
            variant="borderless"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to route, provider, combo, or action..."
            className="!px-0 !text-sm"
          />
          <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface text-text-muted">
            ESC
          </kbd>
        </div>

        <div className="max-h-[360px] overflow-y-auto divide-y divide-border-subtle custom-scrollbar">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-text-muted">
              No matching command or route
            </div>
          ) : (
            items.map((item, idx) => {
              const active = idx === selectedIndex;
              return (
                <button
                  key={`${item.code}-${item.label}-${idx}`}
                  type="button"
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => handleSelect(item)}
                  className={cn(
                    "w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer",
                    active ? "bg-surface-2 text-text-main font-medium" : "hover:bg-surface-2/60"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="material-symbols-outlined text-[16px] text-text-muted shrink-0">
                      {item.group === "ACTION" ? "bolt" : "arrow_forward"}
                    </span>
                    <span className="text-sm font-medium text-text-main truncate">
                      {item.label}
                    </span>
                  </div>
                  <span className="rounded-md text-[11px] font-medium px-2 py-0.5 border border-border bg-bg-alt text-text-muted shrink-0">
                    {item.group}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-bg-alt font-mono text-[10px] text-text-muted">
          <span>↑↓ NAVIGATE · ↵ OPEN</span>
          <span>888router Command Palette</span>
        </div>
      </div>
    </Modal>
  );
}
