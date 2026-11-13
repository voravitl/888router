"use client";

import { cn } from "@/shared/utils/cn";
import { formatResetTime } from "./utils";
import { formatResetTimeDisplay, getQuotaTone } from "./quotaVisuals";

export default function QuotaProgressBar({
  percentage = 0,
  label = "",
  used = 0,
  total = 0,
  unlimited = false,
  resetTime = null,
  recurring = true,
}) {
  const tone = getQuotaTone(percentage);
  const countdown = formatResetTime(resetTime);
  const resetDisplay = formatResetTimeDisplay(resetTime);
  const resetWord = recurring ? "Reset" : "Expires";
  const remaining = Math.min(Math.max(Number(percentage) || 0, 0), 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-text-main truncate">{label}</span>
        <span className={cn("inline-flex items-center gap-1.5 font-mono font-semibold tabular-nums", tone.textClass)}>
          <span className={cn("size-1.5 rounded-full inline-block", tone.dotClass)} aria-hidden="true" />
          {remaining}%
        </span>
      </div>

      {!unlimited && (
        <div className="h-1.5 w-full rounded-full overflow-hidden bg-bg-alt border border-border-subtle">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${remaining}%`, backgroundColor: tone.barColor }}
          />
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-text-muted tabular-nums">
        <span className="font-mono">
          {Number(used || 0).toLocaleString()} / {Number(total || 0).toLocaleString()} req
        </span>
        {countdown !== "-" && (
          <span className="truncate" title={resetDisplay || ""}>
            {resetWord} in {countdown}
          </span>
        )}
      </div>
    </div>
  );
}
