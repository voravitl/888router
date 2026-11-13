import { getRemainingPercentage, isFamilyRollup } from "./utils";

/**
 * Shared monochrome quota tone classification and reset formatting helpers
 * across ProviderLimits views without emoji or duplicated threshold checks.
 */
export function getQuotaTone(remainingPercentage) {
  const pct = Number(remainingPercentage) || 0;
  if (pct > 70) {
    return {
      key: "healthy",
      dotClass: "bg-[#a6c23f]",
      barColor: "#a6c23f",
      textClass: "text-[#6c8618] dark:text-[#a6c23f]",
      badgeClass: "border-[#a6c23f]/35 bg-[#a6c23f]/10 text-[#5f7813] dark:text-[#b7d354]",
    };
  }
  if (pct >= 30) {
    return {
      key: "warning",
      dotClass: "bg-amber-500",
      barColor: "#d97706",
      textClass: "text-amber-700 dark:text-amber-400",
      badgeClass: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  return {
    key: "critical",
    dotClass: "bg-red-500",
    barColor: "#dc2626",
    textClass: "text-red-600 dark:text-red-400",
    badgeClass: "border-red-500/35 bg-red-500/10 text-red-600 dark:text-red-400",
  };
}

export function formatResetTimeDisplay(resetTime) {
  if (!resetTime) return null;
  try {
    const date = new Date(resetTime);
    if (!Number.isFinite(date.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(tomorrow.getTime() + 86400000);

    let dayStr;
    if (date >= today && date < tomorrow) {
      dayStr = "Today";
    } else if (date >= tomorrow && date < dayAfter) {
      dayStr = "Tomorrow";
    } else {
      dayStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${dayStr}, ${timeStr}`;
  } catch {
    return null;
  }
}

export function pickPrimaryQuota(quotas = []) {
  if (!Array.isArray(quotas) || quotas.length === 0) return null;
  const families = quotas.filter(isFamilyRollup);
  const pool = families.length > 0 ? families : quotas;
  // Prefer lowest remaining headroom so constrained windows surface first cleanly
  return [...pool].sort((a, b) => getRemainingPercentage(a) - getRemainingPercentage(b))[0];
}

export function findEarliestResetMs(quotas = []) {
  if (!Array.isArray(quotas) || quotas.length === 0) return null;
  let earliest = Number.POSITIVE_INFINITY;
  let earliestIso = null;
  for (const q of quotas) {
    if (!q?.resetAt) continue;
    const ms = new Date(q.resetAt).getTime();
    if (Number.isFinite(ms) && ms > Date.now() && ms < earliest) {
      earliest = ms;
      earliestIso = q.resetAt;
    }
  }
  return earliestIso;
}
