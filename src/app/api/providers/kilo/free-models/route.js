import { NextResponse } from "next/server";

const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";

// In-memory cache with TTL
let cachedModels = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function GET() {
  const now = Date.now();

  // Return cached result if still valid
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return NextResponse.json({ models: cachedModels, cached: true });
  }

  try {
    const res = await fetch(KILO_MODELS_URL, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Kilo API returned ${res.status}`);
    }

    const json = await res.json();
    const allModels = json.data || [];

    const freeModels = allModels
      .filter((m) => {
        if (!m || typeof m.id !== "string") return false;
        if (m.isFree === true) return true;
        if (m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0") return true;
        if (m.id.endsWith(":free")) return true;
        if (m.id === "kilo-auto/free" || m.id === "meituan/longcat-2.0-free" || m.id === "openrouter/free") return true;
        return false;
      })
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        isFree: true,
        context_length: m.context_length || m.top_provider?.context_length || 0,
      }));

    cachedModels = freeModels;
    cacheTimestamp = now;

    return NextResponse.json({ models: freeModels, cached: false });
  } catch (error) {
    // Return cached data if available, even if expired
    if (cachedModels) {
      return NextResponse.json({ models: cachedModels, cached: true, warning: error.message });
    }

    return NextResponse.json(
      { models: [], error: `Failed to fetch Kilo models: ${error.message}` },
      { status: 502 }
    );
  }
}
