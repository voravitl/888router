/**
 * OpenCode Go usage — GET https://opencode.ai/zen/go/v1/usage
 * Auth: Bearer <apiKey> (the same Go subscription key used for chat).
 * Undocumented endpoint: returns `usage.{rolling,weekly,monthly}` windows,
 * each `{ status, percent, resetsAt }` where `percent` is USED percent.
 * Do not use /api/usage* on opencode.ai — Cloudflare WAF blocks non-browser clients.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const WINDOW_LABELS = {
  rolling: "Rolling (5h)",
  weekly: "Weekly",
  monthly: "Monthly",
};

/**
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 */
export async function getOpenCodeGoUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "OpenCode Go API key not available. Add a key to view usage." };
  }

  try {
    const response = await proxyAwareFetch(
      USAGE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        plan: "OpenCode Go",
        message: "OpenCode Go authentication failed. Check the API key.",
      };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        plan: "OpenCode Go",
        message: `OpenCode Go usage API error (${response.status})${errText ? `: ${errText.slice(0, 120)}` : ""}`,
      };
    }

    const data = await response.json().catch(() => null);
    const windows = data?.usage;
    if (!windows || typeof windows !== "object" || Array.isArray(windows)) {
      return { plan: "OpenCode Go", message: "OpenCode Go connected. No usage data returned." };
    }

    const quotas = {};
    for (const [windowKey, window] of Object.entries(windows)) {
      if (!window || typeof window !== "object") continue;
      const used = Math.max(0, Math.min(100, toFiniteNumber(window.percent, 0)));
      quotas[WINDOW_LABELS[windowKey] || windowKey] = {
        used,
        total: 100,
        remaining: Math.max(0, 100 - used),
        resetAt: window.resetsAt || null,
        unlimited: false,
      };
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: "OpenCode Go", message: "OpenCode Go connected. No usage windows returned." };
    }

    return { plan: "OpenCode Go", quotas };
  } catch (error) {
    return { message: `OpenCode Go error: ${error.message}` };
  }
}
