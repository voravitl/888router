"use client";

import { useState } from "react";
import { Card } from "@/shared/components";
import { AUTO_COMBO_TEMPLATES } from "open-sse/services/autoCombo/builtinCatalog.js";

export default function AutoComboCatalog({ onDuplicate }) {
  const [open, setOpen] = useState(false);

  return (
    <Card padding="sm" className="border-border/80">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-500">
            <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-main">Zero-Config Auto Combos</span>
              <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-500">
                {AUTO_COMBO_TEMPLATES.length} Dynamic Routes
              </span>
            </div>
            <p className="text-[11px] text-text-muted">
              Call directly via API without creating manual combo rows (e.g. <code>auto/best-coding</code>, <code>auto/best-free</code>, <code>auto/coding:fast</code>)
            </p>
          </div>
        </div>
        <span className="material-symbols-outlined text-text-muted">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>

      {open && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AUTO_COMBO_TEMPLATES.map((tpl) => (
            <div
              key={tpl.name}
              className="flex flex-col justify-between rounded-lg border border-border bg-bg-alt/50 p-3"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-text-main">{tpl.name}</span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                    {tpl.strategy}
                  </span>
                </div>
                <div className="mt-1 text-xs font-medium text-text-main">{tpl.displayName}</div>
                <p className="mt-1 text-[11px] text-text-muted">{tpl.description}</p>
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

                {onDuplicate && (
                  <button
                    type="button"
                    onClick={() => onDuplicate(tpl)}
                    className="flex items-center gap-1 text-text-muted hover:text-brand-500 transition-colors"
                    title="Snapshot into customizable combo"
                  >
                    <span className="material-symbols-outlined text-[14px]">content_copy</span>
                    <span>Snapshot</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
