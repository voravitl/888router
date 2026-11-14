"use client";

import { useMemo, useState } from "react";
import { Button } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import { formatResetTime, getRemainingPercentage, isFamilyRollup } from "./utils";
import { formatResetTimeDisplay, getQuotaTone } from "./quotaVisuals";

const PAGE_SIZE = 10;
const FAMILY_ORDER = {
  gemini: 0,
  gemini_argon: 1,
  claude: 2,
};

function sortQuotas(quotas, sortMode) {
  if (sortMode === "remaining-asc") {
    return [...quotas].sort((a, b) => a.remaining - b.remaining || (a.name || "").localeCompare(b.name || ""));
  }
  if (sortMode === "remaining-desc") {
    return [...quotas].sort((a, b) => b.remaining - a.remaining || (a.name || "").localeCompare(b.name || ""));
  }
  return quotas;
}

/**
 * Monochrome Proof Quota Table Component for per-account pooled & model windows.
 * Preserves family-rollup-first pinning above paginated model rows (#403).
 */
export default function QuotaTable({
  quotas = [],
  compact = false,
  sortMode = "default",
  showSortLabel = false,
}) {
  const [showModels, setShowModels] = useState(false);

  const familyRows = useMemo(
    () =>
      (Array.isArray(quotas) ? quotas : [])
        .filter(isFamilyRollup)
        .map((quota, index) => ({
          ...quota,
          index: `family-${index}`,
          remaining: getRemainingPercentage(quota),
          isFamily: true,
        })),
    [quotas]
  );

  const perModelRows = useMemo(
    () =>
      (Array.isArray(quotas) ? quotas : [])
        .filter((quota) => !isFamilyRollup(quota))
        .map((quota, index) => ({
          ...quota,
          index,
          remaining: getRemainingPercentage(quota),
          isFamily: false,
        })),
    [quotas]
  );

  const modelRows = useMemo(() => {
    if (familyRows.length > 0 && !showModels) {
      return [];
    }
    return perModelRows;
  }, [familyRows.length, showModels, perModelRows]);

  const sortedModelRows = useMemo(() => sortQuotas(modelRows, sortMode), [modelRows, sortMode]);

  const sortedFamilyRows = useMemo(() => {
    return [...familyRows].sort((a, b) => {
      const rankA = FAMILY_ORDER[a.family] ?? 99;
      const rankB = FAMILY_ORDER[b.family] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      const famCompare = (a.family || "").localeCompare(b.family || "");
      if (famCompare !== 0) return famCompare;
      const isWeeklyA = a.isWeekly === true || a.name?.toLowerCase().includes("weekly") ? 1 : 0;
      const isWeeklyB = b.isWeekly === true || b.name?.toLowerCase().includes("weekly") ? 1 : 0;
      if (isWeeklyA !== isWeeklyB) return isWeeklyA - isWeeklyB;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [familyRows]);

  const totalPages = Math.max(1, Math.ceil(sortedModelRows.length / PAGE_SIZE));
  const tableSignature = useMemo(
    () => `${sortMode}:${sortedModelRows.map((q) => q.name).join("|")}`,
    [sortMode, sortedModelRows]
  );
  const [pageState, setPageState] = useState({ signature: tableSignature, page: 1 });
  const effectivePage = Math.min(
    pageState.signature === tableSignature ? pageState.page : 1,
    totalPages
  );

  if (!quotas || quotas.length === 0) {
    return null;
  }

  const pagedModelRows = sortedModelRows.slice(
    (effectivePage - 1) * PAGE_SIZE,
    effectivePage * PAGE_SIZE
  );
  const currentPageRows = [...sortedFamilyRows, ...pagedModelRows];
  const pageStart = sortedModelRows.length === 0 ? 0 : (effectivePage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(effectivePage * PAGE_SIZE, sortedModelRows.length);
  const totalRows = sortedFamilyRows.length + sortedModelRows.length;

  const cellPad = compact ? "py-1.5 px-2" : "py-2 px-3";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-text-muted tabular-nums">
          {totalRows} window{totalRows > 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-1.5">
          {showSortLabel && (
            <span className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[10px] font-medium text-text-muted">
              Sorted by remaining
            </span>
          )}
          {sortedFamilyRows.length > 0 && perModelRows.length > 0 && (
            <button
              type="button"
              onClick={() => setShowModels((prev) => !prev)}
              aria-expanded={showModels}
              className="rounded-md border border-border bg-bg-alt px-2 py-0.5 text-[10px] font-medium text-text-muted hover:text-text-main hover:border-text-muted transition-colors cursor-pointer"
            >
              {showModels
                ? "Hide models"
                : `Show ${perModelRows.length} model${perModelRows.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
        <table className="w-full table-fixed text-left">
          <tbody>
            {currentPageRows.map((quota) => {
              const tone = getQuotaTone(quota.remaining);
              const countdown = formatResetTime(quota.resetAt);
              const resetDisplay = formatResetTimeDisplay(quota.resetAt);
              const recurring = quota.recurring !== false;
              const countdownLabel = recurring ? `in ${countdown}` : `expires ${countdown}`;

              return (
                <tr
                  key={`${quota.name}-${quota.index}`}
                  className="border-b last:border-b-0 border-border-subtle hover:bg-bg-alt/60 transition-colors"
                >
                  <td className={`${cellPad} w-[34%]`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`size-1.5 rounded-full shrink-0 ${tone.dotClass}`}
                        aria-hidden="true"
                      />
                      <span
                        className={`${compact ? "text-xs" : "text-[13px]"} font-medium text-text-main truncate`}
                        title={quota.name}
                      >
                        {quota.name}
                      </span>
                    </div>
                  </td>

                  <td className={`${cellPad} w-[42%]`}>
                    <div className="space-y-1">
                      <div className="h-1.5 w-full rounded-full overflow-hidden bg-bg-alt border border-border-subtle">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.min(quota.remaining, 100)}%`,
                            backgroundColor: tone.barColor,
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between font-mono text-[10px] tabular-nums">
                        <span className="text-text-muted truncate">
                          {quota.used.toLocaleString()} / {quota.total > 0 ? quota.total.toLocaleString() : "∞"}
                        </span>
                        <span className={`font-semibold ${tone.textClass}`}>
                          {quota.remaining}%
                        </span>
                      </div>
                    </div>
                  </td>

                  <td className={`${cellPad} w-[24%] text-right`}>
                    {countdown !== "-" || resetDisplay ? (
                      compact ? (
                        <span
                          className="font-mono text-[11px] font-medium text-text-main truncate block"
                          title={resetDisplay || ""}
                        >
                          {countdown !== "-" ? countdownLabel : resetDisplay}
                        </span>
                      ) : (
                        <div className="space-y-0.5">
                          {countdown !== "-" && (
                            <div className="font-mono text-xs font-medium text-text-main">
                              {countdownLabel}
                            </div>
                          )}
                          {resetDisplay && (
                            <div className="text-[10px] text-text-muted">
                              {resetDisplay}
                            </div>
                          )}
                        </div>
                      )
                    ) : (
                      <span className="font-mono text-[11px] text-text-subtle">N/A</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && sortedModelRows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-alt px-2.5 py-1.5 text-[11px] text-text-muted">
          <span className="tabular-nums">
            {pageStart}–{pageEnd} of {sortedModelRows.length}
            {sortedFamilyRows.length > 0 && ` (+${sortedFamilyRows.length} pooled)`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={effectivePage === 1}
              onClick={() =>
                setPageState({
                  signature: tableSignature,
                  page: Math.max(1, effectivePage - 1),
                })
              }
            />
            <span className="px-1.5 font-mono tabular-nums">
              {effectivePage}/{totalPages}
            </span>
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={effectivePage === totalPages}
              onClick={() =>
                setPageState({
                  signature: tableSignature,
                  page: Math.min(totalPages, effectivePage + 1),
                })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
