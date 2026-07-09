// Weighted account-selection scoring: blends quota headroom, success-rate EMA, and
// per-token latency EMA into a single score used to pick the best-performing connection.

import { QUOTA_SNAPSHOT_MAX_AGE_MS } from "./quotaSnapshot.js";

export const SUCCESS_EMA_ALPHA = 0.15;
export const LATENCY_EMA_ALPHA = 0.20;
export const WARMUP_SAMPLES = 10;
export const LATENCY_STEP_CAP_MULTIPLIER = 1.5;
export const LATENCY_REF_MS_PER_TOKEN = 15;
export const STALENESS_DECAY_MS = 60 * 60 * 1000;
export const EPSILON = 0.10;
export const NEAR_BAND = 0.05;
export const HYSTERESIS_DELTA = 0.08;

const STALENESS_TRIGGER_MS = 30 * 60 * 1000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Returns true when an HTTP outcome should count against an account's reliability score
// (auth/rate-limit/server errors, or a transport-level failure with no status at all).
// Client-caused errors (400/404/422/...) never penalize the account.
export function isAccountQualityFailure(status, errorText) {
  try {
    if (!status) return true;
    const s = Number(status);
    if (!Number.isFinite(s)) return true;
    if (s === 401 || s === 403 || s === 429) return true;
    if (s >= 500) return true;
    return false;
  } catch (e) {
    console.warn("[AccountScoring] isAccountQualityFailure error:", e.message);
    return false;
  }
}

// Computes the fields to merge into a connection after a request outcome.
// Pure function — caller persists the returned fields via updateProviderConnection.
export function updateHealthEma(connection, { ok, latencyMs, outputTokens } = {}) {
  try {
    if (ok === undefined || ok === null) return {};

    const conn = connection || {};
    const now = Date.now();

    const oldSuccessEwma = isFiniteNumber(conn.successEwma) ? conn.successEwma : 1.0;
    const successEwma = SUCCESS_EMA_ALPHA * (ok ? 1 : 0) + (1 - SUCCESS_EMA_ALPHA) * oldSuccessEwma;

    const update = {
      successEwma,
      healthSamples: (conn.healthSamples || 0) + 1,
      healthUpdatedAt: new Date(now).toISOString(),
    };

    const hasValidLatency = ok === true && isFiniteNumber(latencyMs) && latencyMs > 0;
    if (hasValidLatency) {
      const hasTokens = isFiniteNumber(outputTokens) && outputTokens > 0;
      const rawSample = hasTokens ? latencyMs / outputTokens : latencyMs;

      // Decay a stale existing EMA toward the neutral reference before using it.
      let existingEma = isFiniteNumber(conn.latEwmaPerTokenMs) ? conn.latEwmaPerTokenMs : null;
      if (existingEma !== null && conn.healthUpdatedAt) {
        const lastUpdateMs = new Date(conn.healthUpdatedAt).getTime();
        if (Number.isFinite(lastUpdateMs) && now - lastUpdateMs > STALENESS_TRIGGER_MS) {
          const idleMs = now - lastUpdateMs;
          const stalenessFactor = Math.min(idleMs / STALENESS_DECAY_MS, 1.0);
          existingEma = existingEma * (1 - stalenessFactor) + LATENCY_REF_MS_PER_TOKEN * stalenessFactor;
        }
      }

      // Dampen a single-step spike so one bad sample can't blow out the EMA.
      const sample = existingEma !== null ? Math.min(rawSample, existingEma * LATENCY_STEP_CAP_MULTIPLIER) : rawSample;
      const baseline = existingEma !== null ? existingEma : LATENCY_REF_MS_PER_TOKEN;
      update.latEwmaPerTokenMs = LATENCY_EMA_ALPHA * sample + (1 - LATENCY_EMA_ALPHA) * baseline;
    }

    return update;
  } catch (e) {
    console.warn("[AccountScoring] updateHealthEma error:", e.message);
    return {};
  }
}

// Computes a 0-1 weighted score for a connection from quota headroom (Q), success-rate (S),
// and latency (L), each ramped in by a confidence factor that grows with sample count.
export function computeScore(connection, now = Date.now()) {
  try {
    const conn = connection || {};

    let Q = 1.0;
    if (isFiniteNumber(conn.quotaRemainingPct)) {
      const checkedAtMs = new Date(conn.quotaCheckedAt).getTime();
      if (Number.isFinite(checkedAtMs) && now - checkedAtMs <= QUOTA_SNAPSHOT_MAX_AGE_MS) {
        Q = clamp01(conn.quotaRemainingPct / 100);
      }
    }

    const confidence = Math.min((conn.healthSamples || 0) / WARMUP_SAMPLES, 1.0);

    const rawS = isFiniteNumber(conn.successEwma) ? conn.successEwma : 1.0;
    const S = confidence * rawS + (1 - confidence) * 1.0;

    let L = 1.0;
    if (isFiniteNumber(conn.latEwmaPerTokenMs)) {
      const rawL = 1 / (1 + conn.latEwmaPerTokenMs / LATENCY_REF_MS_PER_TOKEN);
      L = confidence * rawL + (1 - confidence) * 1.0;
    }

    const score = 0.50 * Q + 0.35 * S + 0.15 * L;
    const reason = `Q=${Q.toFixed(2)} S=${S.toFixed(2)} L=${L.toFixed(2)}`;

    return { score, Q, S, L, reason };
  } catch (e) {
    console.warn("[AccountScoring] computeScore error:", e.message);
    return { score: 0.5, Q: 1, S: 1, L: 1, reason: "error" };
  }
}

// Picks the best-scoring candidate, with hysteresis toward the current pick and a small
// epsilon-greedy exploration chance among near-best candidates.
export function pickByScore(candidates, { currentPickId = null } = {}) {
  try {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { connection: null, breakdown: null };
    }

    const scored = candidates.map((candidate) => ({ candidate, ...computeScore(candidate) }));
    const maxScore = Math.max(...scored.map((s) => s.score));

    if (currentPickId) {
      const current = scored.find((s) => s.candidate.id === currentPickId);
      if (current && maxScore - current.score <= HYSTERESIS_DELTA) {
        return {
          connection: current.candidate,
          breakdown: { connId: current.candidate.id, Q: current.Q, S: current.S, L: current.L, score: current.score, reason: `${current.reason} | sticky` },
        };
      }
    }

    if (Math.random() < EPSILON) {
      const nearBand = scored.filter((s) => maxScore - s.score <= NEAR_BAND);
      const picked = nearBand[Math.floor(Math.random() * nearBand.length)];
      return {
        connection: picked.candidate,
        breakdown: { connId: picked.candidate.id, Q: picked.Q, S: picked.S, L: picked.L, score: picked.score, reason: `${picked.reason} | explore` },
      };
    }

    const topScored = scored.filter((s) => s.score === maxScore);
    let best = topScored[0];
    if (topScored.length > 1) {
      best = [...topScored].sort((a, b) => {
        const aUse = a.candidate.consecutiveUseCount || 0;
        const bUse = b.candidate.consecutiveUseCount || 0;
        if (aUse !== bUse) return aUse - bUse;
        if (!a.candidate.lastUsedAt && !b.candidate.lastUsedAt) return 0;
        if (!a.candidate.lastUsedAt) return -1;
        if (!b.candidate.lastUsedAt) return 1;
        return new Date(a.candidate.lastUsedAt) - new Date(b.candidate.lastUsedAt);
      })[0];
    }

    return {
      connection: best.candidate,
      breakdown: { connId: best.candidate.id, Q: best.Q, S: best.S, L: best.L, score: best.score, reason: `${best.reason} | best` },
    };
  } catch (e) {
    console.warn("[AccountScoring] pickByScore error:", e.message);
    const fallback = candidates?.[0];
    return {
      connection: fallback || null,
      breakdown: fallback ? { connId: fallback.id, Q: 1, S: 1, L: 1, score: 0.5, reason: "pickByScore error fallback" } : null,
    };
  }
}
