import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { estimateRequestTokens } from "../services/requestContext.js";

// The wait for the upstream's RESPONSE HEADERS is a FIRST-BYTE deadline, not
// a connect timeout: the AbortController that enforces it is cleared only
// after the fetch resolves, and a fetch resolves when the headers arrive.
//
// Measured live on 2026-10-25 against the ollama upstream:
//   connect (TCP+TLS)   : 12 ms
//   headers arrived at  : 5 631 ms
//   first body chunk at : 5 633 ms
// The upstream buffers the whole answer and then sends the headers, so
// "time to headers" is "time to first token" and nothing like a connect.
// Under 6-way concurrency the same upstream answered at 8.0 / 9.4 / 10.6 /
// 11.5 / 12.5 / 13.9 s — so a 10 s budget aborted four of six HEALTHY
// requests and reported it as "502 fetch connect timeout".
//
// The deadline must therefore be the provider's patience (the same
// FETCH_CONNECT_TIMEOUT_MS the standalone path gets), not a flat 10 s. The
// socket connect stays bounded by the fetch's own timeout, so a dead host
// still fails fast instead of holding the request for the full window.
const NORMAL_HEADER_WAIT_MS = FETCH_CONNECT_TIMEOUT_MS;

// Long uploads/prefill need a larger bounded wait before useful output. Normal
// requests retain the fast failover policy; explicit operator overrides win.
export function getRequestTimeoutPolicy(body) {
  const longContext = estimateRequestTokens(body) >= 100000;
  const configured = Number(process.env.LONG_CONTEXT_TIMEOUT_MS);
  const longWait = Number.isFinite(configured) && configured > 0
    ? Math.min(Math.max(Math.round(configured), FETCH_CONNECT_TIMEOUT_MS), 300000)
    : Math.max(FETCH_CONNECT_TIMEOUT_MS, 180000);
  return {
    longContext,
    connectTimeoutMs: longContext ? longWait : NORMAL_HEADER_WAIT_MS,
    firstChunkTimeoutMs: longContext ? longWait : 30000,
    stallTimeoutMs: longContext ? Math.max(FETCH_CONNECT_TIMEOUT_MS, 60000) : 30000,
    headDeadlineMs: longContext ? Math.max(longWait, 180000) : 120000,
    totalBudgetMs: longContext ? Math.max(longWait * 2, 360000) : 180000,
  };
}
