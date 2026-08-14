import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const PRUNE_THROTTLE_MS = 5 * 60 * 1000; // 5 min
let lastPruneTs = 0;
const CONFIG_CACHE_TTL_MS = 5000;
let cachedConfig = null;
let cachedConfigTs = 0;

function parseNum(val, fallback) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const parsed = parseInt(val, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function resetPruneThrottle() {
  lastPruneTs = 0;
}

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : (typeof settings.enableObservability2 === "boolean"
        ? settings.enableObservability2
        : envEnabled);
    cachedConfig = {
      enabled,
      maxRecords: parseNum(settings.observabilityMaxRecords, parseNum(process.env.OBSERVABILITY_MAX_RECORDS, DEFAULT_MAX_RECORDS)),
      retentionDays: parseNum(settings.observabilityRetentionDays, parseNum(process.env.OBSERVABILITY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS)),
      batchSize: parseNum(settings.observabilityBatchSize, parseNum(process.env.OBSERVABILITY_BATCH_SIZE, DEFAULT_BATCH_SIZE)),
      flushIntervalMs: parseNum(settings.observabilityFlushIntervalMs, parseNum(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS)),
      maxJsonSize: parseNum(settings.observabilityMaxJsonSize, parseNum(process.env.OBSERVABILITY_MAX_JSON_SIZE, 5)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      retentionDays: DEFAULT_RETENTION_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

let flushPromise = null;

async function flushToDatabase() {
  if (flushPromise) return flushPromise;
  if (writeBuffer.length === 0) return;
  flushPromise = (async () => {
    try {
      // Drain entire buffer (loop in case more pushed during await)
      while (writeBuffer.length > 0) {
        const items = writeBuffer.splice(0, writeBuffer.length);
        const db = await getAdapter();
        const config = await getObservabilityConfig();

        db.transaction(() => {
          for (const item of items) {
            if (!item.id) item.id = generateDetailId(item.model);
            if (!item.timestamp) item.timestamp = new Date().toISOString();
            if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

            // Denormalized hot stats (DBA fix): extracted at write time so
            // getTokenSaveSummary reads these columns instead of the data blob.
            const ps = item.prunerStats;
            const rtkStats = item.rtkStats;
            const hs = item.headroomStats;
            const hd = item.headroomDiagnostics;
            const record = {
              id: item.id,
              provider: item.provider || null,
              model: item.model || null,
              // Client-facing model (combo/alias) before upstream expansion
              clientModel: item.clientModel || item.request?.model || null,
              connectionId: item.connectionId || null,
              timestamp: item.timestamp,
              status: item.status || null,
              latency: item.latency || {},
              tokens: item.tokens || {},
              request: truncateField(item.request, config.maxJsonSize),
              providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
              providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
              response: truncateField(item.response, config.maxJsonSize),
              // Token-saver benchmark fields (must survive flush — dropped previously)
              prunerStats: ps || null,
              rtkStats: rtkStats || null,
              headroomStats: hs || null,
              headroomDiagnostics: item.headroomDiagnostics || null,
              prunerTokensBefore: ps?.tokensBefore ?? null,
              prunerTokensAfter: ps?.tokensAfter ?? null,
              prunerTokensSaved: ps?.tokensSaved ?? null,
              prunerOmitted: ps?.omittedMessages ?? null,
              rtkBytesBefore: rtkStats?.bytesBefore ?? null,
              rtkBytesAfter: rtkStats?.bytesAfter ?? null,
              rtkBytesSaved: typeof rtkStats?.bytesBefore === "number" && typeof rtkStats?.bytesAfter === "number"
                ? Math.max(0, rtkStats.bytesBefore - rtkStats.bytesAfter)
                : null,
              // Real producer (compressWithHeadroom) emits snake_case tokens_saved;
              // older UI/test fixtures used savedTokens — honor both.
              headroomTokensSaved: hs?.tokens_saved ?? hs?.savedTokens ?? null,
              headroomBytesSaved: typeof hs?.bytesBefore === "number" && typeof hs?.bytesAfter === "number"
                ? Math.max(0, hs.bytesBefore - hs.bytesAfter)
                : typeof hd?.beforeBytes === "number" && typeof hd?.afterBytes === "number"
                  ? Math.max(0, hd.beforeBytes - hd.afterBytes)
                  : null,
              cacheHit: item.cacheHit === true ? 1 : 0,
            };

            db.run(
              `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, prunerTokensBefore, prunerTokensAfter, prunerTokensSaved, prunerOmitted, rtkBytesBefore, rtkBytesAfter, rtkBytesSaved, headroomTokensSaved, headroomBytesSaved, cacheHit) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data, prunerTokensBefore = excluded.prunerTokensBefore, prunerTokensAfter = excluded.prunerTokensAfter, prunerTokensSaved = excluded.prunerTokensSaved, prunerOmitted = excluded.prunerOmitted, rtkBytesBefore = excluded.rtkBytesBefore, rtkBytesAfter = excluded.rtkBytesAfter, rtkBytesSaved = excluded.rtkBytesSaved, headroomTokensSaved = excluded.headroomTokensSaved, headroomBytesSaved = excluded.headroomBytesSaved, cacheHit = excluded.cacheHit`,
              [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record), record.prunerTokensBefore, record.prunerTokensAfter, record.prunerTokensSaved, record.prunerOmitted, record.rtkBytesBefore, record.rtkBytesAfter, record.rtkBytesSaved, record.headroomTokensSaved, record.headroomBytesSaved, record.cacheHit]
            );
          }

          // Time-based retention (throttled to at most once per 5 minutes):
          // delete records older than retentionDays so period reports (24h/7d/30d)
          // have real data. Previously this pruned by COUNT (keep newest N), which
          // dropped everything older than ~2 days and made the 30d report return
          // the same data as 7d.
          const nowMs = Date.now();
          if (config.retentionDays > 0 && (nowMs - lastPruneTs >= PRUNE_THROTTLE_MS)) {
            const cutoff = new Date(nowMs - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
            db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]);
            lastPruneTs = nowMs;
          }
          // Count cap as a safety net: time-based retention alone can let the
          // table grow unbounded on high-traffic gateways (each row holds
          // truncated request/response JSON). Keep the newest maxRecords rows.
          if (config.maxRecords > 0) {
            const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
            if (cnt && cnt.c > config.maxRecords) {
              db.run(
                `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
                [cnt.c - config.maxRecords]
              );
            }
          }
        });
      }
    } catch (e) {
      console.error("[requestDetailsRepo] Batch write failed:", e);
    } finally {
      flushPromise = null;
    }
  })();
  return flushPromise;
}

export async function flushRequestDetailsBuffer() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flushToDatabase();
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Flush immediately when token-saver stats or final usage are present so
  // playground/benchmark UIs can read them without waiting the batch interval.
  const hasTokenSaveStats = Boolean(detail?.prunerStats || detail?.rtkStats || detail?.headroomStats || detail?.headroomDiagnostics);
  const hasUsage = Boolean(detail?.tokens && (detail.tokens.prompt_tokens || detail.tokens.completion_tokens || detail.tokens.input_tokens || detail.tokens.output_tokens));
  // "empty" (reasoning stream ended with zero text content) is a terminal
  // result like success — flush it promptly so the condition is observable.
  const isTerminal = detail?.status === "success" || detail?.status === "empty";
  const forceFlush = hasTokenSaveStats || (isTerminal && hasUsage);

  // Trigger immediate flush if batch threshold reached or forceFlush.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (forceFlush || writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

/**
 * Aggregate RTK + Headroom savings across request details in a time window.
 * Caveman/Ponytail are prompt-only and not metered here.
 */
export async function getTokenSaveSummary({ startDate, endDate, limit = 2000 } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (startDate) {
    conds.push("timestamp >= ?");
    params.push(new Date(startDate).toISOString());
  }
  if (endDate) {
    conds.push("timestamp <= ?");
    params.push(new Date(endDate).toISOString());
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 5000);

  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalInWindow = cntRow ? cntRow.c : 0;

  const rows = db.all(
    `SELECT id, timestamp, model, provider, prunerTokensSaved, rtkBytesSaved, headroomTokensSaved, prunerTokensBefore, prunerTokensAfter, prunerOmitted, rtkBytesBefore, rtkBytesAfter, headroomBytesSaved, cacheHit FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ?`,
    [...params, safeLimit],
  );

  const pruner = {
    requestsWithStats: 0,
    requestsWithSavings: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    omittedMessages: 0,
  };
  const rtk = {
    requestsWithStats: 0,
    requestsWithSavings: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    filterHits: {},
  };
  const headroom = {
    requestsWithStats: 0,
    requestsWithSavings: 0,
    tokensSaved: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    skipReasons: {},
    /** @type {Record<string, number>} */
    skipReasonsRecent24h: {},
    skipNewestAt: null,
  };
  const cache = {
    hits: 0,
    requests: 0,
  };
  const recent = [];
  /** @type {Record<string, { date: string, before: number, after: number, saved: number, requests: number }>} */
  const byDay = {};
  const recent24hCutoff = Date.now() - 24 * 60 * 60 * 1000;

  function noteSkipReason(reason, timestamp) {
    const key = String(reason).slice(0, 120);
    headroom.skipReasons[key] = (headroom.skipReasons[key] || 0) + 1;
    const ts = timestamp ? new Date(timestamp).getTime() : NaN;
    if (Number.isFinite(ts) && ts >= recent24hCutoff) {
      headroom.skipReasonsRecent24h[key] = (headroom.skipReasonsRecent24h[key] || 0) + 1;
    }
    if (Number.isFinite(ts)) {
      const prev = headroom.skipNewestAt ? new Date(headroom.skipNewestAt).getTime() : 0;
      if (ts >= prev) headroom.skipNewestAt = new Date(ts).toISOString();
    }
  }

  for (const row of rows) {
    // New rows: numeric aggregates come from extracted columns (no blob parse).
    // Old rows: columns are null → parse the data blob as before (COALESCE fallback).
    const hasColumns = row.prunerTokensBefore != null || row.prunerTokensSaved != null ||
      row.rtkBytesBefore != null || row.rtkBytesSaved != null ||
      row.headroomTokensSaved != null || row.headroomBytesSaved != null;
    // data column is no longer selected (columns-only aggregate) — rows with
    // null columns (pre-backfill) can't fall back to the blob anymore.
    const detail = hasColumns ? {} : (row.data ? parseJson(row.data, {}) : {});
    if (row.prunerTokensBefore == null && row.prunerTokensSaved == null && row.prunerOmitted == null) {
      const ps = detail?.prunerStats;
      if (ps && typeof ps.tokensBefore === "number") {
        row.prunerTokensBefore = ps.tokensBefore || 0;
        row.prunerTokensAfter = ps.tokensAfter ?? 0;
        row.prunerTokensSaved = ps.tokensSaved || 0;
        row.prunerOmitted = ps.omittedMessages || 0;
      }
    }
    if (row.rtkBytesBefore == null && row.rtkBytesSaved == null) {
      const rtkStats = detail?.rtkStats;
      if (rtkStats && typeof rtkStats.bytesBefore === "number" && typeof rtkStats.bytesAfter === "number") {
        row.rtkBytesBefore = rtkStats.bytesBefore;
        row.rtkBytesAfter = rtkStats.bytesAfter;
        row.rtkBytesSaved = Math.max(0, rtkStats.bytesBefore - rtkStats.bytesAfter);
      }
    }
    if (row.headroomTokensSaved == null && row.headroomBytesSaved == null) {
      const hs = detail?.headroomStats;
      const diag = detail?.headroomDiagnostics || {};
      if (hs && typeof hs.savedTokens === "number" && hs.savedTokens > 0) {
        row.headroomTokensSaved = hs.savedTokens;
      } else if (diag && (diag.beforeBytes != null || diag.bytesBefore != null)) {
        const before = diag.beforeBytes ?? diag.bytesBefore ?? 0;
        const after = diag.afterBytes ?? diag.bytesAfter ?? 0;
        row.headroomBytesSaved = Math.max(0, before - after);
      }
      if (diag.reason) noteSkipReason(diag.reason, detail.timestamp);
    }
    const isCacheHit = row.cacheHit != null ? row.cacheHit === 1 : detail?.cacheHit === true;
    const dayKey = (row.timestamp && String(row.timestamp).slice(0, 10)) || (detail.timestamp && String(detail.timestamp).slice(0, 10)) || "unknown";

    // Track response cache hits
    cache.requests += 1;
    if (isCacheHit) cache.hits += 1;

    let prunerTokensSaved = 0;
    if (row.prunerTokensBefore != null) {
      pruner.requestsWithStats += 1;
      pruner.tokensBefore += row.prunerTokensBefore || 0;
      pruner.tokensAfter += row.prunerTokensAfter || 0;
      prunerTokensSaved = row.prunerTokensSaved || 0;
      if (prunerTokensSaved > 0) {
        pruner.requestsWithSavings += 1;
        pruner.tokensSaved += prunerTokensSaved;
      }
      pruner.omittedMessages += row.prunerOmitted || 0;
    }

    let rtkSaved = 0;
    let rtkPct = 0;
    if (row.rtkBytesBefore != null && row.rtkBytesAfter != null) {
      rtk.requestsWithStats += 1;
      rtk.bytesBefore += row.rtkBytesBefore;
      rtk.bytesAfter += row.rtkBytesAfter;
      rtkSaved = row.rtkBytesSaved != null ? row.rtkBytesSaved : Math.max(0, row.rtkBytesBefore - row.rtkBytesAfter);
      if (rtkSaved > 0) {
        rtk.requestsWithSavings += 1;
        rtk.bytesSaved += rtkSaved;
      }
      if (row.rtkBytesBefore > 0) {
        rtkPct = Math.round((rtkSaved / row.rtkBytesBefore) * 100);
      }
      if (Array.isArray(detail?.rtkStats?.hits)) {
        for (const hit of detail.rtkStats.hits) {
          const key = hit?.filter || hit?.shape || "other";
          rtk.filterHits[key] = (rtk.filterHits[key] || 0) + 1;
        }
      } else if (row.rtkBytesSaved != null) {
        // Columns-only path: filterHits live in the data blob (not selected).
        // Dropped from the aggregate (ponytail: re-add via a targeted
        // SELECT data for rows WITH hits if the dashboard needs filter chips).
      }
      if (!byDay[dayKey]) {
        byDay[dayKey] = { date: dayKey, before: 0, after: 0, saved: 0, requests: 0 };
      }
      byDay[dayKey].before += row.rtkBytesBefore;
      byDay[dayKey].after += row.rtkBytesAfter;
      byDay[dayKey].saved += rtkSaved;
      byDay[dayKey].requests += 1;
    }

    let hrTokens = 0;
    let hrBytesSaved = 0;
    if (row.headroomTokensSaved != null && row.headroomTokensSaved > 0) {
      headroom.requestsWithStats += 1;
      headroom.requestsWithSavings += 1;
      headroom.tokensSaved += row.headroomTokensSaved;
      hrTokens = row.headroomTokensSaved;
    } else if (row.headroomBytesSaved != null && row.headroomBytesSaved > 0) {
      headroom.requestsWithStats += 1;
      headroom.requestsWithSavings += 1;
      headroom.bytesSaved += row.headroomBytesSaved;
      hrBytesSaved = row.headroomBytesSaved;
    }

    if ((rtkSaved > 0 || hrTokens > 0 || hrBytesSaved > 0) && recent.length < 12) {
      recent.push({
        id: row.id || detail.id || null,
        timestamp: row.timestamp || detail.timestamp || null,
        model: row.model || detail.clientModel || detail.model || null,
        provider: row.provider || detail.provider || null,
        rtkBytesSaved: rtkSaved || 0,
        rtkPct,
        headroomTokensSaved: hrTokens || 0,
        headroomBytesSaved: hrBytesSaved || 0,
      });
    }
  }

  const topFilters = Object.entries(rtk.filterHits)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topSkipReasons = Object.entries(headroom.skipReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
  const topSkipReasonsRecent24h = Object.entries(headroom.skipReasonsRecent24h)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  // Oldest → newest for charts (unknown last)
  const series = Object.values(byDay)
    .filter((d) => d.date !== "unknown")
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    period: {
      startDate: startDate || null,
      endDate: endDate || null,
      scanned: rows.length,
      totalInWindow,
      truncated: totalInWindow > rows.length,
    },
    pruner: {
      ...pruner,
      pctSaved: pruner.tokensBefore > 0 ? Math.round((pruner.tokensSaved / pruner.tokensBefore) * 100) : 0,
    },
    rtk: {
      ...rtk,
      pctSaved: rtk.bytesBefore > 0 ? Math.round((rtk.bytesSaved / rtk.bytesBefore) * 100) : 0,
      topFilters,
    },
    headroom: {
      ...headroom,
      pctBytesSaved: headroom.bytesBefore > 0
        ? Math.round((headroom.bytesSaved / headroom.bytesBefore) * 100)
        : 0,
      topSkipReasons,
      topSkipReasonsRecent24h,
    },
    cache: {
      ...cache,
      hitRate: cache.requests > 0 ? Math.round((cache.hits / cache.requests) * 100) : 0,
    },
    // Chart-friendly series: daily RTK tool-blob bytes (not full bill)
    series,
    recent,
    notes: {
      rtk: "Measures tool_result compression in bytes (before → after).",
      headroom: "Measures context compress when proxy succeeds (tokens or bytes).",
      caveman: "Prompt-only: no per-request before/after meter.",
      ponytail: "Prompt-only: no per-request before/after meter.",
    },
  };
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
