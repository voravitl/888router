import { getAipassQuota, hasConnectedClients } from "../aipassBridge.js";
import { resolveAipassHost } from "../../config/providers.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

export async function getAipassUsage(apiKey, providerSpecificData = {}, proxyOptions = null) {
  // 1. Try built-in bridge hub first if extension is connected
  if (hasConnectedClients()) {
    const quota = await getAipassQuota();
    if (quota) {
      const remainingPct = quota.limit > 0 ? Math.round((quota.available / quota.limit) * 100) : 100;
      return {
        plan: "AiPASS Citizen Free",
        periodEndsAt: quota.periodEndsAt,
        quotas: {
          credits: {
            used: quota.used,
            total: quota.limit,
            remainingPercentage: remainingPct,
            displayName: "AiPASS Credits",
          },
        },
      };
    }
  }

  // 2. Fall back to standalone bridge /quota endpoint
  try {
    const host = resolveAipassHost({ providerSpecificData });
    const res = await proxyAwareFetch(`${host}/quota`, {
      headers: { "Content-Type": "application/json" },
    }, proxyOptions);
    if (res.ok) {
      const data = await res.json();
      const credits = data.creditStatus?.credits || data.credits;
      const decimals = Number(data.creditStatus?.creditsDecimals ?? 6);
      const factor = Math.pow(10, decimals);
      const limit = Number(credits?.limit ?? 0) / factor;
      const used = Number(credits?.used ?? 0) / factor;
      const available = Number(credits?.available ?? 0) / factor;
      const remainingPct = limit > 0 ? Math.round((available / limit) * 100) : 100;
      return {
        plan: "AiPASS Citizen Free",
        periodEndsAt: data.creditStatus?.periodEndsAt || null,
        quotas: {
          credits: {
            used,
            total: limit,
            remainingPercentage: remainingPct,
            displayName: "AiPASS Credits",
          },
        },
      };
    }
  } catch {}

  return {
    plan: "AiPASS (Disconnected)",
    error: "No extension connected and standalone bridge unreachable",
    quotas: {
      credits: {
        used: 0,
        total: 0,
        remainingPercentage: 0,
        displayName: "AiPASS Credits",
      },
    },
  };
}

export default getAipassUsage;
