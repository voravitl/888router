/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA } from "../../config/appConstants.js";
import { PROVIDERS } from "../../providers/index.js";
import { ANTIGRAVITY_OAUTH_CLIENT, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";
import { fetchAntigravityWeeklyQuota } from "./antigravity-weekly.js";

// Antigravity API config (from Quotio) — urls from registry, oauth client + dynamic UA kept here
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: ANTIGRAVITY_IDE_USER_AGENT,
};

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.quotaApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
      },
      body: JSON.stringify({
        ...(projectId ? { project: projectId } : {})
      }),
    }, 10000, proxyOptions);

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    // Detect tier: free/starter-tier accounts only have weekly quotas (no
    // separate 5h window), and fetchAvailableModels returns misleading
    // per-model quota info for them.
    //
    // Antigravity has NO free tier (repo owner, 2026-09-29) — paidTierId is
    // always present for a real account. So free/starter is only ever claimed
    // when the tier id ITSELF says so; the previous tierName-substring and
    // missing-paidTierId fallbacks could misclassify a paid account as free
    // when the API shape omitted those fields, which silently discarded the
    // per-model quotas and degraded the quota cache to strike-only blocking
    // (15m) instead of the real window (e.g. 80h).
    const paidTierId = subscriptionInfo?.paidTier?.id;
    const tierId = String(paidTierId || "").toLowerCase();

    const isFreeTier =
      tierId.includes("free") ||
      tierId.includes("starter");

    // Parse model quotas only for paid-tier accounts.
    if (!isFreeTier && data.models) {
      // Filter only recommended/important models (must match PROVIDER_MODELS ag ids)
      const importantModels = [
        'gemini-2.5-pro',
        'gemini-4-hydrogen',
        'gemini-4-hydrogen-xhigh',
        'gemini-4-hydrogen-high',
        'gemini-4-hydrogen-medium',
        'gemini-4-hydrogen-low',
        'gemini-4-hydrogen-tiered',
        'gemini-4-argon-high',
        'gemini-4-argon-medium',
        'gemini-4-argon-low',
        'gemini-3.8-flash-tiered',
        'gemini-3.8-flash-high',
        'gemini-3.8-flash-medium',
        'gemini-3.8-flash-low',
        'gemini-3.7-flash-tiered',
        'gemini-3.7-flash-high',
        'gemini-3.7-flash-medium',
        'gemini-3.7-flash-low',
        'gemini-3.6-flash-tiered',
        'gemini-3.6-flash-high',
        'gemini-3.6-flash-medium',
        'gemini-3.6-flash-low',
        'gemini-3-flash-agent',
        'gemini-3-flash',
        'gemini-3.5-flash-low',
        'gemini-3.5-flash-extra-low',
        'gemini-3.5-flash-lite',
        'gemini-pro-agent',
        'gemini-3.1-pro-high',
        'gemini-3.1-pro-low',
        'gemini-3.1-flash-lite',
        'claude-sonnet-5-5-high',
        'claude-sonnet-5-5-medium',
        'claude-sonnet-5-5-low',
        'claude-opus-5-5-high',
        'claude-opus-5-5-medium',
        'claude-opus-5-5-low',
        'gpt-oss-120b-medium',
        // Image generation models
        'gemini-3.1-flash-image',
      ];

      // Family rollup: Gemini versions share one pooled quota server-side, so
      // per-version bars all move together and confuse. Aggregate per family
      // (Gemini / Gemini 4 Argon / Claude) using the MINIMUM remaining fraction —
      // the tightest pool is what the user can actually still spend.
      // Per-model rows are kept under `models` for drill-down; the UI renders
      // the family rows as the primary bars.
      const familyFractions = { gemini: [], gemini_argon: [], claude: [] };
      const familyResets = { gemini: [], gemini_argon: [], claude: [] };

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip models without quota info
        if (!info.quotaInfo) {
          continue;
        }

        // Skip internal models and non-important models
        if (info.isInternal || !importantModels.includes(modelKey)) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;

        // Convert percentage to used/total for UI compatibility
        const total = 1000; // Normalized base
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;

        // Use modelKey as key (matches PROVIDER_MODELS id)
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };

        // Classify into family for rollup. Non-LLM modalities (image) are
        // excluded — separate pool, not part of the LLM quota. The check
        // uses the registry `kind`, not the id: image ids also start with
        // "gemini" (e.g. gemini-3.1-flash-image) and a prefix test alone
        // would wrongly pull them in. Non-gemini/claude members (e.g.
        // gpt-oss-120b-medium) stay per-model only — no third family, by
        // intent (rollup covers the two pooled families the user asked
        // about; a new pooled family means a new explicit branch here).
        const lowerKey = modelKey.toLowerCase();
        const registryKind = PROVIDERS?.antigravity?.models?.find(
          (m) => typeof m === "object" && m !== null && m.id === modelKey
        )?.kind;
        const family =
          registryKind && registryKind !== "chat"
            ? null
            : lowerKey.startsWith("claude")
              ? "claude"
              : lowerKey.includes("argon")
                ? "gemini_argon"
                : lowerKey.startsWith("gemini") || lowerKey.startsWith("gemini-pro-agent")
                  ? "gemini"
                  : null;
        if (family) {
          familyFractions[family].push(remainingFraction);
          const resetAt = parseResetTime(info.quotaInfo.resetTime);
          if (resetAt) familyResets[family].push(resetAt);
        }
      }

      const FAMILY_LABELS = {
        gemini: "Gemini",
        gemini_argon: "Gemini 4 Argon",
        claude: "Claude",
      };

      // Emit one rollup row per family that has at least one member.
      for (const [family, fractions] of Object.entries(familyFractions)) {
        if (fractions.length === 0) continue;
        const minFraction = Math.min(...fractions);
        const total = 1000;
        const remaining = Math.round(total * minFraction);
        const label = FAMILY_LABELS[family] || family;
        quotas[`${label} (all models)`] = {
          used: total - remaining,
          total,
          // Earliest reset across members — the first pool to refill.
          resetAt: familyResets[family].length
            ? familyResets[family].sort()[0]
            : null,
          remainingPercentage: minFraction * 100,
          unlimited: false,
          displayName: `${label} (all models)`,
          family,
          familyKey: family,
          memberCount: fractions.length,
        };
      }

      // Registry aliases `gemini-4-hydrogen` to `gemini-4-hydrogen(high)`, while
      // live daily-cloudcode-pa `:fetchAvailableModels` returns `gemini-4-hydrogen-high`.
      if (!quotas["gemini-4-hydrogen"] && quotas["gemini-4-hydrogen-high"]) {
        quotas["gemini-4-hydrogen"] = {
          ...quotas["gemini-4-hydrogen-high"],
          displayName: "Gemini 4 Hydrogen",
        };
      }
    }

    // Best-effort weekly quota overlay — never blocks or breaks per-model results.
    try {
      const weeklyQuotas = await fetchAntigravityWeeklyQuota(
        accessToken,
        projectId,
        proxyOptions
      );

      // If every per-model quota in a family is exhausted, do not show a
      // misleading available weekly quota for that family.
      // Note: Argon has its own weekly limit group and is handled separately from the pooled Gemini models.
      const entries = Object.entries(quotas);
      const geminiModels = entries.filter(([key]) => key.startsWith("gemini-") && !key.includes("image") && !key.includes("argon"));
      const argonModels = entries.filter(([key]) => key.includes("argon"));
      const claudeModels = entries.filter(([key]) => key.startsWith("claude-"));

      const reconcileFamilyWeekly = (weeklyQuota, familyRollupKey, modelEntries) => {
        if (!weeklyQuota || modelEntries.length === 0) return;
        const allExhausted = modelEntries.every(([, quota]) => (quota.remainingPercentage ?? 0) === 0);
        if (allExhausted && weeklyQuota.remainingPercentage > 0) {
          const maxResetAt = modelEntries.reduce((max, [, quota]) =>
            !max || (quota.resetAt && new Date(quota.resetAt) > new Date(max)) ? quota.resetAt : max, null
          );
          weeklyQuota.used = weeklyQuota.total;
          weeklyQuota.remainingPercentage = 0;
          if (maxResetAt) weeklyQuota.resetAt = maxResetAt;
        } else if (weeklyQuota?.remainingPercentage === 0) {
          // When weekly quota is exhausted, the 5h pool does not apply — user is blocked
          const rollup = quotas[familyRollupKey];
          if (rollup) {
            rollup.used = rollup.total;
            rollup.remainingPercentage = 0;
            if (weeklyQuota.resetAt) {
              rollup.resetAt = weeklyQuota.resetAt;
            }
          }
          for (const [, quota] of modelEntries) {
            quota.used = quota.total;
            quota.remainingPercentage = 0;
            if (weeklyQuota.resetAt) {
              quota.resetAt = weeklyQuota.resetAt;
            }
          }
        }
      };

      reconcileFamilyWeekly(weeklyQuotas.gemini_weekly, "Gemini (all models)", geminiModels);
      reconcileFamilyWeekly(weeklyQuotas.gemini_argon_weekly, "Gemini 4 Argon (all models)", argonModels);
      reconcileFamilyWeekly(weeklyQuotas.claude_gpt_weekly, "Claude (all models)", claudeModels);

      Object.assign(quotas, weeklyQuotas);
    } catch {
      // Silently ignore — weekly is best-effort.
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
