"use client";

import { useState } from "react";
import { Button, Tag } from "antd";
import { CheckOutlined, CopyOutlined, DownOutlined, ThunderboltOutlined, UpOutlined } from "@ant-design/icons";
import { Card } from "@/shared/components";
import { AUTO_COMBO_TEMPLATES } from "open-sse/services/autoCombo/builtinCatalog.js";
import { withClaudeCodeSuffix } from "@/shared/utils/claudeCodeModelId";

export default function AutoComboCatalog({
  onDuplicate,
  onCopy,
  copiedId = null,
  defaultOpen = true,
  compact = false,
  embedded = false,
}) {
  const [open, setOpen] = useState(defaultOpen);

  const gridClass = compact
    ? "grid grid-cols-1 gap-3"
    : "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5";

  const cards = (
    <div className={gridClass}>
      {AUTO_COMBO_TEMPLATES.map((tpl) => {
        const ctx = tpl.contextMin || 0;
        const copyText = withClaudeCodeSuffix(tpl.name, ctx);
        const isCopied = copiedId === `tpl-${tpl.name}`;

        return (
          <div
            key={tpl.name}
            className="flex flex-col justify-between rounded-xl border border-border bg-surface p-4 hover:border-border-strong transition-colors"
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <code className="font-mono text-xs font-semibold text-text-main break-all">
                  {tpl.name}
                </code>
                <Tag className="m-0 font-mono text-[10px] shrink-0">{tpl.strategy}</Tag>
              </div>
              <div className="mt-2 text-xs font-semibold text-text-main">{tpl.displayName}</div>
              <p className="mt-1 text-[11px] text-text-muted leading-relaxed">{tpl.description}</p>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
              <div className="flex flex-wrap gap-1">
                {tpl.categories.map((c) => (
                  <span
                    key={c}
                    className="rounded border border-border bg-bg-alt px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                  >
                    {c}
                  </span>
                ))}
                {tpl.tiers
                  .filter((t) => !(tpl.categories || []).includes(t))
                  .map((t) => (
                    <span
                      key={t}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                        t === "free"
                          ? "border-[#a6c23f]/35 bg-[#a6c23f]/10 text-[#5f7813] dark:text-[#b7d354]"
                          : "border-border bg-bg-alt text-text-main"
                      }`}
                    >
                      {t}
                    </span>
                  ))}
              </div>

              <div className="flex items-center gap-1.5">
                {onCopy && (
                  <Button
                    size="small"
                    icon={isCopied ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopy(copyText, `tpl-${tpl.name}`);
                    }}
                    title={`Copy "${tpl.name}" — usable directly as a model ID in Claude Code / Cursor / Cline`}
                  >
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                )}
                {onDuplicate && (
                  <Button
                    size="small"
                    type="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(tpl);
                    }}
                    title="Snapshot into customizable combo"
                  >
                    Snapshot
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex size-8 items-center justify-center rounded-lg border border-border bg-bg-alt text-text-main shrink-0">
              <ThunderboltOutlined />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-text-main">Zero-Config Dynamic Auto Routes</span>
                <span className="rounded border border-[#a6c23f]/35 bg-[#a6c23f]/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#5f7813] dark:text-[#b7d354]">
                  {AUTO_COMBO_TEMPLATES.length} live
                </span>
              </div>
              <p className="text-[11px] text-text-muted leading-snug m-0 mt-0.5">
                Call directly as a virtual model ID (<code className="font-mono text-text-main">auto/best-coding</code>, <code className="font-mono text-text-main">auto/best-free</code>, <code className="font-mono text-text-main">auto/coding:fast</code>) without manual configuration.
              </p>
            </div>
          </div>
        </div>
        {cards}
      </div>
    );
  }

  return (
    <Card padding="sm" className="border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 text-left cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-main shrink-0">
            <ThunderboltOutlined />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-text-main">Zero-Config Auto Combos</span>
              <span className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[11px] font-mono text-text-main">
                {AUTO_COMBO_TEMPLATES.length} routes
              </span>
            </div>
            <p className="text-[11px] text-text-muted mt-0.5 leading-snug">
              Call directly (<code className="font-mono text-text-main">auto/best-coding</code>, <code className="font-mono text-text-main">auto/best-free</code>, <code className="font-mono text-text-main">auto/coding:fast</code>) or snapshot to customize.
            </p>
          </div>
        </div>
        <span className="text-text-muted shrink-0">
          {open ? <UpOutlined /> : <DownOutlined />}
        </span>
      </button>

      {open && <div className="mt-4">{cards}</div>}
    </Card>
  );
}
