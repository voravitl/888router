// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { PROVIDER_ID_TO_ALIAS, AI_PROVIDERS } from "@/shared/constants/providers";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/**
 * GET /api/usage/summary
 * Aggregates per-provider usage/limits across every active connection.
 * Used by OMC HUD (and any client) to render weekly/hourly limit bars for
 * whichever providers the user has configured — not just Anthropic.
 *
 * Response shape:
 *   { providers: [{ id, alias, name, usage }] }
 *
 * `usage` is the raw shape returned by open-sse/services/usage/<provider>.js
 * (claude: five_hour/seven_day, kiro: weekly, codebuddy: ..., etc.). Failed
 * or not-implemented providers are returned with { skipped: true, reason } so
 * the caller can tell "no data" from "not connected".
 *
 * Cookie-authed (matches /api/models).
 */
export async function GET() {
  try {
    const connections = await getProviderConnections();
    const active = connections.filter((c) => c && c.isActive !== false);

    // Fan out in parallel — slow providers don't block others.
    const results = await Promise.all(
      active.map(async (conn) => {
        const id = conn.provider;
        const alias = PROVIDER_ID_TO_ALIAS[id] || id;
        const name = AI_PROVIDERS[id]?.display?.name || id;
        const proxyOptions = resolveConnectionProxyConfig(conn);
        try {
          const usage = await getUsageForProvider(conn, proxyOptions);
          return { id, alias, name, usage };
        } catch (e) {
          return { id, alias, name, skipped: true, reason: e?.message || "fetch_failed" };
        }
      }),
    );

    return NextResponse.json({ providers: results });
  } catch (error) {
    console.error("[API] /api/usage/summary failed:", error);
    return NextResponse.json({ error: "Failed to fetch usage summary" }, { status: 500 });
  }
}
