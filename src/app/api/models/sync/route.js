import { NextResponse } from "next/server";
import { getSyncedModelsMap } from "@/lib/db";
import { getProviderConnections } from "@/lib/localDb";
import {
  AI_PROVIDERS,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
  isPublicModelsProvider,
  providerSupportsModelSync,
  resolveProviderId,
} from "@/shared/constants/providers";
import { GET as syncProviderModels } from "@/app/api/providers/[id]/models/route.js";

export const dynamic = "force-dynamic";

const MAX_CONCURRENCY = 4;
const TARGET_TIMEOUT_MS = 10000;

function pickLatestIso(currentIso, candidateIso) {
  if (!candidateIso || typeof candidateIso !== "string") return currentIso;
  const candidateMs = Date.parse(candidateIso);
  if (!Number.isFinite(candidateMs)) return currentIso;
  if (!currentIso) return candidateIso;
  const currentMs = Date.parse(currentIso);
  if (!Number.isFinite(currentMs) || candidateMs > currentMs) return candidateIso;
  return currentIso;
}

function parseSyncedKey(key, connProviderById) {
  if (typeof key !== "string") return { connectionId: null, provider: null };
  if (key.startsWith("public:")) {
    const secondColon = key.indexOf(":", "public:".length);
    if (secondColon > "public:".length) {
      const connectionId = key.slice(0, secondColon);
      const provider = key.slice("public:".length, secondColon);
      return { connectionId, provider };
    }
    return { connectionId: "public", provider: "public" };
  }
  const colon = key.indexOf(":");
  if (colon <= 0) return { connectionId: null, provider: null };
  const connectionId = key.slice(0, colon);
  return {
    connectionId,
    provider: connProviderById.get(connectionId) || null,
  };
}

function summarizeSyncedModels(syncedMap, connections = []) {
  const connProviderById = new Map();
  for (const conn of connections) {
    if (conn?.id && conn?.provider) {
      connProviderById.set(conn.id, conn.provider);
    }
  }

  let totalSyncedEntries = 0;
  let activeCount = 0;
  let staleCount = 0;
  let lastSyncedAt = null;
  const byConnection = {};
  const byProvider = {};

  for (const [key, entry] of Object.entries(syncedMap || {})) {
    totalSyncedEntries += 1;
    const isStale = entry?.status === "stale";
    if (isStale) staleCount += 1;
    else activeCount += 1;

    const ts = entry?.lastSyncedAt || null;
    lastSyncedAt = pickLatestIso(lastSyncedAt, ts);

    const { connectionId, provider } = parseSyncedKey(key, connProviderById);
    if (connectionId) {
      if (!byConnection[connectionId]) {
        byConnection[connectionId] = {
          provider: provider ?? null,
          activeCount: 0,
          staleCount: 0,
          lastSyncedAt: null,
        };
      }
      if (isStale) byConnection[connectionId].staleCount += 1;
      else byConnection[connectionId].activeCount += 1;
      byConnection[connectionId].lastSyncedAt = pickLatestIso(
        byConnection[connectionId].lastSyncedAt,
        ts,
      );
    }

    if (provider) {
      if (!byProvider[provider]) {
        byProvider[provider] = {
          activeCount: 0,
          staleCount: 0,
          lastSyncedAt: null,
        };
      }
      if (isStale) byProvider[provider].staleCount += 1;
      else byProvider[provider].activeCount += 1;
      byProvider[provider].lastSyncedAt = pickLatestIso(
        byProvider[provider].lastSyncedAt,
        ts,
      );
    }
  }

  return {
    totalSyncedEntries,
    activeCount,
    staleCount,
    lastSyncedAt,
    byConnection,
    byProvider,
  };
}

function getInFlightMap() {
  if (!(globalThis.__modelSyncInFlight instanceof Map)) {
    globalThis.__modelSyncInFlight = new Map();
  }
  return globalThis.__modelSyncInFlight;
}

async function parseOptionalBody(request) {
  if (!request) return {};
  try {
    if (typeof request.text === "function") {
      const raw = await request.text();
      if (!raw || !raw.trim()) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    if (typeof request.json === "function") {
      const parsed = await request.json();
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
  } catch {
    // Optional JSON body — treat empty/invalid body as {}
  }
  return {};
}

async function runTargetWithTimeout(target) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Sync timed out after ${TARGET_TIMEOUT_MS}ms`));
    }, TARGET_TIMEOUT_MS);
  });

  const execPromise = (async () => {
    const req = new Request(`http://localhost/api/providers/${encodeURIComponent(target.id)}/models`);
    const res = await syncProviderModels(req, { params: Promise.resolve({ id: target.id }) });
    const status = res?.status ?? 200;
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (status >= 400 || data?.error) {
      return {
        connectionId: target.connectionId,
        provider: target.provider,
        ok: false,
        modelCount: 0,
        error: data?.error || `HTTP ${status}`,
      };
    }

    const models = Array.isArray(data?.models) ? data.models : [];
    return {
      connectionId: target.connectionId,
      provider: target.provider,
      ok: true,
      modelCount: models.length,
      ...(data?.warning ? { warning: data.warning } : {}),
    };
  })();

  // Prevent unhandled rejection if execPromise settles after timeout fires.
  execPromise.catch(() => {});

  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } catch (error) {
    return {
      connectionId: target.connectionId,
      provider: target.provider,
      ok: false,
      modelCount: 0,
      error: error?.message || "Sync failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        results[idx] = await worker(items[idx]);
      }
    }),
  );
  return results;
}

function selectSyncTargets(connections, { providerId, connectionId }) {
  const canonicalProvider = providerId ? (resolveProviderId(providerId) || providerId) : null;
  const targets = [];

  for (const conn of connections) {
    if (!conn || conn.isActive === false) continue;
    if (connectionId && conn.id !== connectionId) continue;
    if (providerId && conn.provider !== providerId && conn.provider !== canonicalProvider) continue;
    if (!providerSupportsModelSync(conn.provider)) continue;
    if (
      (isOpenAICompatibleProvider(conn.provider) || isAnthropicCompatibleProvider(conn.provider)) &&
      !conn.providerSpecificData?.baseUrl
    ) {
      continue;
    }
    targets.push({
      id: conn.id,
      connectionId: conn.id,
      provider: conn.provider,
    });
  }

  if (!connectionId && providerId && targets.length === 0) {
    if (isPublicModelsProvider(providerId) || isPublicModelsProvider(canonicalProvider)) {
      const targetProvider = AI_PROVIDERS[providerId] ? providerId : (canonicalProvider || providerId);
      targets.push({
        id: targetProvider,
        connectionId: `public:${targetProvider}`,
        provider: targetProvider,
      });
    }
  }

  return targets;
}

async function executeSync({ providerId, connectionId }) {
  let connections = [];
  try {
    connections = (await getProviderConnections()) || [];
  } catch {
    connections = [];
  }

  const targets = selectSyncTargets(connections, { providerId, connectionId });
  const results = await runWithConcurrency(targets, MAX_CONCURRENCY, runTargetWithTimeout);

  let syncedMap = {};
  try {
    syncedMap = (await getSyncedModelsMap()) || {};
  } catch {
    syncedMap = {};
  }
  const summary = summarizeSyncedModels(syncedMap, connections);

  const okResults = results.filter((r) => r.ok);
  const syncedProviders = new Set(okResults.map((r) => r.provider).filter(Boolean)).size;
  const syncedConnections = okResults.length;
  const totalModels = results.reduce((sum, r) => sum + (r.modelCount || 0), 0);

  return {
    ok: true,
    syncedProviders,
    syncedConnections,
    totalModels,
    activeCount: summary.activeCount,
    staleCount: summary.staleCount,
    lastSyncedAt: summary.lastSyncedAt,
    results,
  };
}

// GET /api/models/sync - Aggregated sync status across connections and providers
export async function GET() {
  try {
    const syncedMap = (await getSyncedModelsMap()) || {};
    let connections = [];
    try {
      connections = (await getProviderConnections()) || [];
    } catch {
      connections = [];
    }
    return NextResponse.json(summarizeSyncedModels(syncedMap, connections));
  } catch (error) {
    console.log("Error summarizing synced models:", error);
    return NextResponse.json({ error: "Failed to summarize synced models" }, { status: 500 });
  }
}

// POST /api/models/sync - Trigger unified model sync across active connections
export async function POST(request) {
  try {
    const body = await parseOptionalBody(request);
    const providerId = typeof body.providerId === "string" && body.providerId.trim()
      ? body.providerId.trim()
      : null;
    const connectionId = typeof body.connectionId === "string" && body.connectionId.trim()
      ? body.connectionId.trim()
      : null;

    const scope = !providerId && !connectionId
      ? "all"
      : `${providerId || "*"}:${connectionId || "*"}`;

    const inFlight = getInFlightMap();
    const existing = inFlight.get(scope);
    if (existing) {
      const payload = await existing;
      return NextResponse.json(payload);
    }

    const runPromise = executeSync({ providerId, connectionId });
    inFlight.set(scope, runPromise);

    try {
      const payload = await runPromise;
      return NextResponse.json(payload);
    } finally {
      if (inFlight.get(scope) === runPromise) {
        inFlight.delete(scope);
      }
    }
  } catch (error) {
    console.log("Error executing unified model sync:", error);
    return NextResponse.json({ error: "Failed to sync models" }, { status: 500 });
  }
}
