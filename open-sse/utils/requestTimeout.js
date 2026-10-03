import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { estimateRequestTokens } from "../services/requestContext.js";

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
    connectTimeoutMs: longContext ? longWait : 10000,
    firstChunkTimeoutMs: longContext ? longWait : 30000,
    stallTimeoutMs: longContext ? Math.max(FETCH_CONNECT_TIMEOUT_MS, 60000) : 30000,
    headDeadlineMs: longContext ? Math.max(longWait, 180000) : 120000,
    totalBudgetMs: longContext ? Math.max(longWait * 2, 360000) : 180000,
  };
}
