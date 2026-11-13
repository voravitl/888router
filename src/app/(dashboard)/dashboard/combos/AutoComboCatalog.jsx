"use client";

import { useState } from "react";
import { Card } from "@/shared/components";
import { AUTO_COMBO_TEMPLATES } from "open-sse/services/autoCombo/builtinCatalog.js";
import { withClaudeCodeSuffix } from "@/shared/utils/claudeCodeModelId";

export default function AutoComboCatalog({ onDuplicate, onCopy, copiedId = null, defaultOpen = false, compact = false }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Card padding="sm" className="hyperion-card border border-border/70">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-400">
            <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-text-main">Zero-Config Auto Combos</span>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-400">
                {AUTO_COMBO_TEMPLATES.length} Dynamic Routes
              </span>
            </div>
            <p className="text-[11px] text-text-muted mt-0.5">
              Call directly via API without creating manual combo rows (e.g. <code>auto/best-coding</code>, <code>auto/best-free</code>, <code>auto/coding:fast</code>)
            </p>
          </div>
        </div>
        <span className="material-symbols-outlined text-text-muted rounded-lg border border-border/50 p-1">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className={`mt-4 grid grid-cols-1 gap-3 ${compact ? "" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
          {AUTO_COMBO_TEMPLATES.map((tpl) => (
            <div
              key={tpl.name}
              className="flex flex-col justify-between rounded-xl border border-border/70 bg-black/[0.03] dark:bg-white/[0.02] p-3.5 hover:border-cyan-500/35 transition-colors"
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold text-cyan-400">{tpl.name}</span>
                  <span className="rounded-md border border-border/60 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                    {tpl.strategy}
                  </span>
                </div>
                <div className="mt-1.5 text-xs font-semibold text-text-main">{tpl.displayName}</div>
                <p className="mt-1 text-[11px] text-text-muted leading-relaxed">{tpl.description}</p>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10px]">
                <div className="flex gap-1">
                  {tpl.categories.map((c) => (
                    <span key={c} className="rounded bg-brand-500/10 px-1.5 py-0.5 text-brand-500">
                      {c}
                    </span>
                  ))}
                  {tpl.tiers.map((t) => (
                    <span key={t} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-500">
                      {t}
                    </span>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  {onCopy && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Claude Code reads context window from a hardcoded registry and
                        // needs the "[1m]" suffix to activate its 1M entry for custom ids.
                        // Only append "[1m]" for combos that actually carry 1M context;
                        // other auto combos keep their (smaller) default window.
                        const ctx = tpl.contextMin || 0;
                        const copyText = withClaudeCodeSuffix(tpl.name, ctx);
                        onCopy(copyText, `tpl-${tpl.name}`);
                      }}
                      className="flex items-center gap-1 text-text-muted hover:text-brand-500 transition-colors"
                      title={`Copy "${tpl.name}" — usable directly as a model ID in Claude Code / Cursor / Cline`}
                    >
                      <span className="material-symbols-outlined text-[14px]">{copiedId === `tpl-${tpl.name}` ? "check" : "data_object"}</span>
                      <span>{copiedId === `tpl-${tpl.name}` ? "Copied" : "Copy"}</span>
                    </button>
                  )}
                  {onDuplicate && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDuplicate(tpl);
                      }}
                      className="flex items-center gap-1 text-text-muted hover:text-brand-500 transition-colors"
                      title="Snapshot into customizable combo"
                    >
                      <span className="material-symbols-outlined text-[14px]">content_copy</span>
                      <span>Snapshot</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
