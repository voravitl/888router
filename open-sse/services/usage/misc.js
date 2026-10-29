/**
 * Misc usage handlers (Qwen, iFlow, Ollama, GLM, Vercel AI Gateway, Qoder)
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U } from "./shared.js";

// GLM quota endpoints (region-aware) — url from registry transport.usage
const GLM_QUOTA_URLS = {
  international: U("glm").url,
  china: U("glm-cn").url,
};

// Vercel AI Gateway credits endpoint
// Returns { balance: "95.50", total_used: "4.50" } (USD as decimal strings).
const VERCEL_AI_GATEWAY_CREDITS_URL = U("vercel-ai-gateway").url;

/**
 * Qwen Usage
 */
export async function getQwenUsage(accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: "Qwen connected. No resource URL available." };
    }

    // Qwen may have usage endpoint at resource URL
    return { message: "Qwen connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch Qwen usage." };
  }
}

/**
 * iFlow Usage
 */
export async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Billing day of month (1–31) stored on an Ollama connection, or null.
 * Accepts an integer or an all-digit string; anything else is ignored so a
 * malformed value falls back to the rolling window instead of a wrong cycle.
 */
export function parseOllamaBillingDay(value) {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

// The billing day in a given month, clamped to that month's last day (31 → Feb 28).
function billingDateInMonth(year, month, billingDay) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(billingDay, lastDay)));
}

/**
 * Current Ollama billing cycle for a billing day: { start, end } at 00:00 UTC.
 * The usage API reports whole UTC days, so the cycle is resolved per UTC day;
 * on the billing day itself the new cycle has already begun.
 */
export function getOllamaBillingCycle(billingDay, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const thisMonth = billingDateInMonth(year, month, billingDay);
  const start = now >= thisMonth ? thisMonth : billingDateInMonth(year, month - 1, billingDay);
  const end = billingDateInMonth(start.getUTCFullYear(), start.getUTCMonth() + 1, billingDay);
  return { start, end };
}

/**
 * USD spent since `start`, summed from the daily /api/usage buckets.
 * Returns NaN when the buckets cannot prove the whole cycle: missing or
 * malformed buckets, a bucket that straddles the cycle start, or buckets that
 * do not reach back to it. A partial sum would understate spend and show
 * credit that is already gone.
 */
export function sumOllamaCycleUsage(buckets, start) {
  if (!Array.isArray(buckets) || buckets.length === 0) return NaN;
  const startMs = start.getTime();
  let earliest = Infinity;
  let total = 0;
  for (const bucket of buckets) {
    const from = Date.parse(bucket?.from);
    const until = Date.parse(bucket?.until);
    const usd = Number(bucket?.usage_usd);
    if (!Number.isFinite(from) || !Number.isFinite(until) || !Number.isFinite(usd)) return NaN;
    if (from < startMs && until > startMs) return NaN;
    earliest = Math.min(earliest, from);
    if (from >= startMs) total += usd;
  }
  return earliest <= startMs ? total : NaN;
}

/**
 * Ollama Cloud Usage
 * Calls https://ollama.com/api/usage?range=30d and https://ollama.com/api/me.
 *
 * REAL /api/usage shape (verified live 2026-10-25, re-read 2026-10-29):
 *   { range, from, until,
 *     totals: { request_count, usage_usd, input_tokens,
 *               cached_input_tokens, output_tokens },
 *     buckets: [{ from, until, usage_usd, ... }, ...] }   // one per UTC day
 *   - range accepts "7d" (default) and "30d"; from/until params are ignored.
 *   - totals.usage_usd is the USD actually spent in the window. The old
 *     { activity, limits.monthly.usage } shape is GONE upstream — parsing it
 *     silently yielded 0 and the quota card showed a fake 100% remaining
 *     while the account had real spend (90.57 USD/30d observed live).
 *
 * Credit ceilings (from /api/me response.Plan field):
 *   "pro" → $60, "max" → $300, "team" → $1000, else → 0 (free, pay-as-you-go)
 *
 * Billing cycle: included credits refresh monthly on the day the
 * subscription started (https://ollama.com/pricing), NOT on the 1st, and the
 * API exposes no reset date. When the connection stores that day as
 * providerSpecificData.resetDay (1–31), usage is the sum of the daily buckets
 * since the current cycle began and resetAt is the next billing day. Without
 * it, the rolling 30-day total is the only proxy and no reset date is
 * invented. Missing spend data must SKIP the row, never render $0 used.
 */
export async function getOllamaUsage(accessToken, providerSpecificData, apiKey) {
  const token = apiKey || accessToken;
  if (!token) return { message: "Ollama API key not available." };

  const billingDay = parseOllamaBillingDay(providerSpecificData?.resetDay);
  const cycle = billingDay ? getOllamaBillingCycle(billingDay, new Date()) : null;

  try {
    // Fetch usage + user plan in parallel
    const [usageRes, meRes] = await Promise.all([
      proxyAwareFetch("https://ollama.com/api/usage?range=30d", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }),
      proxyAwareFetch("https://ollama.com/api/me", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      }).catch(() => null),
    ]);

    if (usageRes.status === 401 || usageRes.status === 403) {
      return { message: "Ollama API key invalid or expired. Re-enter key in Settings." };
    }

    const usageData = usageRes.ok ? await usageRes.json().catch(() => null) : null;
    const meData    = meRes?.ok  ? await meRes.json().catch(() => null)     : null;

    // Resolve plan: prefer /api/me response, fall back to providerSpecificData
    const planRaw = (meData?.Plan || providerSpecificData?.plan || "free").toLowerCase();
    let monthlyCredits = 0;
    let planLabel = "Free (Pay-As-You-Go)";
    if (planRaw.includes("team")) { monthlyCredits = 1000; planLabel = "Team ($500/mo)"; }
    else if (planRaw.includes("max")) { monthlyCredits = 300;  planLabel = "Max ($100/mo)"; }
    else if (planRaw.includes("pro")) { monthlyCredits = 60;   planLabel = "Pro ($20/mo)"; }

    // totals.usage_usd = USD actually spent in the rolling window
    const windowUsd = Number(usageData?.totals?.usage_usd);
    if (!usageData || !Number.isFinite(windowUsd)) {
      // Shape drifted again → say so. A 0 default here renders a fake
      // "100% remaining" — the exact bug this fix removes (2026-10-25).
      return { plan: planLabel, message: "Ollama Cloud usage data unavailable.", quotas: {} };
    }

    // With a known billing day, count only the current cycle's spend.
    const usageUsd = cycle ? sumOllamaCycleUsage(usageData.buckets, cycle.start) : windowUsd;
    if (!Number.isFinite(usageUsd)) {
      return { plan: planLabel, message: "Ollama Cloud billing-cycle usage data unavailable.", quotas: {} };
    }

    const usedUsd = Math.round(usageUsd * 100) / 100;
    const quotas = {};

    if (monthlyCredits > 0) {
      const remaining = Math.max(0, monthlyCredits - usedUsd);
      quotas["Monthly Credits"] = {
        name: "Monthly Credits",
        used: usedUsd,
        total: monthlyCredits,
        remaining: Math.round(remaining * 100) / 100,
        remainingPercentage: Math.round((remaining / monthlyCredits) * 100),
        unit: "USD",
        resetAt: cycle ? cycle.end.toISOString() : null,
      };
    } else {
      // Free tier has no ceiling: show real spend without inventing a
      // percentage (same unlimited-row pattern as Vercel AI Gateway).
      quotas["Used (USD)"] = {
        name: "Used (USD)",
        used: usedUsd,
        total: 0,
        remaining: 0,
        remainingPercentage: 100,
        unlimited: true,
      };
    }

    return { plan: planLabel, quotas };
  } catch (error) {
    return { message: `Unable to fetch Ollama Cloud usage: ${error.message}` };
  }
}

/**
 * GLM Coding Plan usage (international + China regions)
 */
export async function getGlmUsage(apiKey, provider, proxyOptions = null) {
  if (!apiKey) {
    return { message: "GLM API key not available." };
  }

  const region = provider === "glm-cn" ? "china" : "international";
  const quotaUrl = GLM_QUOTA_URLS[region];

  try {
    const response = await proxyAwareFetch(quotaUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (!response.ok) {
      if (response.status === 401) {
        return { message: "GLM API key invalid or expired." };
      }
      return { message: `GLM quota API error (${response.status}).` };
    }

    const json = await response.json();
    const data = json?.data && typeof json.data === "object" ? json.data : {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const quotas = {};

    for (const limit of limits) {
      if (!limit || limit.type !== "TOKENS_LIMIT") continue;
      const usedPercent = Number(limit.percentage) || 0;
      const resetMs = Number(limit.nextResetTime) || 0;
      const remaining = Math.max(0, 100 - usedPercent);

      quotas["session"] = {
        used: usedPercent,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetMs > 0 ? new Date(resetMs).toISOString() : null,
        unlimited: false,
      };
    }

    const levelRaw = typeof data.level === "string" ? data.level : "";
    const plan = levelRaw
      ? levelRaw.charAt(0).toUpperCase() + levelRaw.slice(1).toLowerCase()
      : "Unknown";

    return { plan, quotas };
  } catch (error) {
    return { message: `GLM error: ${error.message}` };
  }
}

/**
 * Vercel AI Gateway usage — credit balance for the API key
 *
 * Calls GET /v1/credits which returns:
 *   { "balance": "95.50", "total_used": "4.50" }   (USD as decimal strings)
 *
 * We surface this as a single "Balance ($)" quota row so the existing
 * QuotaTable / progress-bar UI can render it. used = total_used,
 * total = balance + total_used (the original credit allotment), so the
 * remaining percentage equals balance / total.
 *
 * Docs: https://vercel.com/docs/ai-gateway/usage
 */
export async function getVercelAiGatewayUsage(apiKey, proxyOptions = null) {
  if (!apiKey) {
    return { message: "Vercel AI Gateway API key not available." };
  }

  try {
    const response = await proxyAwareFetch(VERCEL_AI_GATEWAY_CREDITS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "Vercel AI Gateway API key invalid or expired." };
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const trimmed = errorText ? `: ${errorText.slice(0, 200)}` : "";
      return { message: `Vercel AI Gateway credits API error (${response.status})${trimmed}` };
    }

    const data = await response.json();

    // Vercel returns numeric strings; coerce safely.
    const balance = Number(data?.balance) || 0;
    const totalUsed = Number(data?.total_used) || 0;

    // Vercel gives $5/month free credit. The API doesn't return the
    // monthly allocation so we use the known constant as the denominator.
    const MONTHLY_CREDIT = 5;
    const remainingPercentage = (balance / MONTHLY_CREDIT) * 100;

    if (balance <= 0 && totalUsed <= 0) {
      return {
        plan: "Pay-as-you-go",
        message: "Vercel AI Gateway connected. No credit allocation found (BYOK or unfunded account).",
        quotas: {},
      };
    }

    // "Used (USD)": how much has been spent this month (no fixed cap → unlimited).
    // "Remaining (USD)": balance remaining out of the $5 monthly allocation.
    return {
      plan: "Pay-as-you-go",
      quotas: {
        "Used (USD)": {
          used: totalUsed,
          total: 0,
          remaining: 0,
          remainingPercentage: 100,
          unlimited: true,
        },
        "Remaining (USD)": {
          used: balance,
          total: MONTHLY_CREDIT,
          remaining: balance,
          remainingPercentage,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    return { message: `Vercel AI Gateway error: ${error.message}` };
  }
}

export async function getQoderUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Qoder usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      U("qoder").url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      return { message: `Qoder connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body) {
      return { message: "Qoder connected. Usage response was not JSON." };
    }
    // Quota records live under `quotas`; scalar metadata
    // (totalUsagePercentage, isQuotaExceeded, expiresAt) are surfaced as
    // siblings so the dashboard parser doesn't try to render them as rows.
    const userQuota = body.userQuota || {};
    const orgQuota = body.orgResourcePackage || {};
    // Qoder publishes a single absolute reset timestamp (`expiresAt` in ms);
    // surface it on every quota record as ISO so the table can render
    // "resets at" alongside used/total.
    const expiresAtMs = Number.isFinite(Number(body.expiresAt)) && Number(body.expiresAt) > 0
      ? Number(body.expiresAt)
      : null;
    const resetAt = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    const quotas = {
      user: {
        total: Number(userQuota.total) || 0,
        used: Number(userQuota.used) || 0,
        remaining: Number(userQuota.remaining) || 0,
        unit: userQuota.unit || "credits",
        resetAt,
      },
      organization: {
        total: Number(orgQuota.total) || 0,
        used: Number(orgQuota.used) || 0,
        remaining: Number(orgQuota.remaining) || 0,
        unit: orgQuota.unit || "credits",
        resetAt,
      },
    };
    return {
      quotas,
      totalUsagePercentage: Number(body.totalUsagePercentage) || 0,
      isQuotaExceeded: !!body.isQuotaExceeded,
      expiresAt: expiresAtMs,
    };
  } catch (error) {
    return { message: `Qoder connected. Unable to fetch usage: ${error.message}` };
  }
}
