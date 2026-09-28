/**
 * ZCode (Z.ai start-plan) usage — GET /api/v1/zcode-plan/billing/current
 * Auth: Bearer <OAuth accessToken>. The billing response shape is not
 * publicly documented, so parse defensively: anything that looks like a
 * quota/limit entry contributes a row, otherwise surface a generic message.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const BILLING_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";

const PCT_KEYS = ["percent", "percentUsed", "percent_used", "usedPercent", "used_percent", "percentage"];
const LIMIT_KEYS = ["limit", "total", "quota", "allowance"];
const USED_KEYS = ["used", "usage", "consumed"];
const LABEL_KEYS = ["name", "label", "type", "item", "plan", "model"];

function pushWindowQuota(quotas, rawName, entry) {
  const pct = PCT_KEYS.map((k) => toFiniteNumber(entry?.[k], Number.NaN)).find(Number.isFinite);
  const limit = LIMIT_KEYS.map((k) => toFiniteNumber(entry?.[k], Number.NaN)).find(Number.isFinite);
  const used = USED_KEYS.map((k) => toFiniteNumber(entry?.[k], Number.NaN)).find(Number.isFinite);
  const resetAt = entry?.resetAt || entry?.resetsAt || entry?.reset_at || entry?.expiresAt || null;

  if (Number.isFinite(pct)) {
    const usedPct = Math.max(0, Math.min(100, pct));
    quotas[rawName] = {
      used: usedPct,
      total: 100,
      remaining: Math.max(0, 100 - usedPct),
      resetAt,
      unlimited: false,
    };
    return true;
  }

  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
    quotas[rawName] = {
      used: Math.max(0, used),
      total: limit,
      resetAt,
      unlimited: false,
    };
    return true;
  }

  return false;
}

function looksLikeQuotaEntry(entry) {
  return PCT_KEYS.some((k) => entry?.[k] !== undefined) ||
    LIMIT_KEYS.some((k) => entry?.[k] !== undefined) ||
    USED_KEYS.some((k) => entry?.[k] !== undefined);
}

function collectEntries(data, out, depth = 0) {
  if (!data || typeof data !== "object" || depth > 4) return;
  if (Array.isArray(data)) {
    data.forEach((item) => collectEntries(item, out, depth + 1));
    return;
  }
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      collectEntries(value, out, depth + 1);
      continue;
    }
    if (looksLikeQuotaEntry(value)) {
      const label = LABEL_KEYS.map((k) => value[k]).find((v) => typeof v === "string" && v.trim());
      out.push([label || key, value]);
    } else {
      // Wrapper objects (e.g. { data: { plan: {...} } }) — descend.
      collectEntries(value, out, depth + 1);
    }
  }
}

export async function getZcodeUsage(accessToken = null, proxyOptions = null) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return { message: "ZCode OAuth token not available. Re-connect the account to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      BILLING_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return { plan: "ZCode Free", message: "ZCode authentication failed. Re-connect the account." };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { plan: "ZCode Free", message: `ZCode billing API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}` };
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { plan: "ZCode Free", message: "ZCode connected. No billing data returned." };
    }

    const entries = [];
    collectEntries(data, entries);

    const quotas = {};
    for (const [name, entry] of entries) {
      pushWindowQuota(quotas, name, entry);
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: "ZCode Free", message: "ZCode connected. No quota rows returned by billing API." };
    }

    return { plan: "ZCode Free", quotas };
  } catch (error) {
    return { message: `ZCode usage error: ${error.message}` };
  }
}
