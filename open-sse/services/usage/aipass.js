import { getAipassQuota, hasConnectedClients } from "../aipassBridge.js";

export async function getAipassUsage() {
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

  // Standalone-bridge fallback removed: the extension hub is the only transport
  // (port 8787 belongs to headroom, and ECONNREFUSED there reads as a usage bug).
  return {
    plan: "AiPASS (Disconnected)",
    error: "AiPASS extension not connected — open de.aipass.net/chat",
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
