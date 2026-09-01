/**
 * DuckDuckGo Web (Duck.ai) Executor
 *
 * Reverse-engineered handshake (closes #338 / #339):
 *   1. GET https://duckduckgo.com/duckchat/v1/status with browser-like
 *      headers + the essential cookies (`5`, `dcm`, `dcs`). The response
 *      carries the dynamic `x-vqd-hash-1` header — that is the value the
 *      chat endpoint expects in the `x-vqd-4` slot for the next request.
 *   2. POST https://duckduckgo.com/duckchat/v1/chat with the constructed
 *      payload + the static anti-bot headers (`x-fe-signals`,
 *      `x-fe-version`, the `x-vqd-hash-1` we just fetched, etc.).
 *   3. The response is SSE. On 418 (I'm a teapot) or 429 the client
 *      refreshes the VQD and retries — same backoff is the upstream's
 *      job; we just keep one in-memory cache.
 *
 * Source: https://github.com/benoitpetit/duckduckgo-chat-cli (Go, archived)
 *         https://github.com/benoitpetit/duckduckGO-chat-api (reference impl)
 * The crucial breakthrough (per the Go README): `x-vqd-hash-1` is a *static*
 * base64-encoded blob that the browser fingerprints once at build time and
 * re-sends on every chat — we do the same.
 *
 * Important: the static blob below was extracted from a real Chrome 138
 * session in March 2026. DuckDuckGo refreshes these occasionally (every
 * few weeks per the maintainers' notes); when the API starts returning
 * 418 across the board, the fix is to refresh this constant, not to
 * introduce browser automation.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Browser-like User-Agent — keep in lock-step with x-fe-version so DDG's
// fingerprint checks pass (their detection compares the two).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const SEC_CH_UA = `"Not)A;Brand";v="8", "Chromium";v="138", "Brave";v="138"`;

// Static anti-bot headers (refresh every few weeks when upstream rotates
// them — see README). Kept as module-level constants so they live across
// requests in the same process.
const X_FE_VERSION = "serp_20250710_090702_ET-70eaca6aea2948b0bb60";
const X_FE_SIGNALS =
  "eyJzdGFydCI6MTc1MjE1NTc3NzQ4MCwiZXZlbnRzIjpbeyJuYW1lIjoic3RhcnROZXdDaGF0IiwiZGVsdGEiOjc1fSx7Im5hbWUiOiJyZWNlbnRDaGF0c0xpc3RJbXByZXNzaW9uIiwiZGVsdGEiOjEyNH1dLCJlbmQiOjQzNDN9";
const X_VQD_HASH_1 =
  "eyJzZXJ2ZXJfaGFzaGVzIjpbImRQSlJJTWczZnFYQXIvaStaa3c2cEpFVzEwckdTdmxJVlVkNlFsOVRGWXc9IiwiMUN3Qzg3N0Q3WXE1dzlEeTc0UjhBVi9qZVZWaUlYbmV0Q0xvckx3c01QZz0iLCJQSzc3TGc2L25weDdWQ2J2UWxsTEhBR3cyenJIVmEvQUFBRFBhQTl1ekVRPSJdLCJjbGllbnRfaGFzaGVzIjpbImxWblI0MStCMVFWZ0o0d0hhMUdBNmdxR0JoSjlWdjN5K0dISkdGekJmTGM9IiwiVS9RRUc2RE1qdEU4V2hHU1FxOUU1Z0VGNmw1SWJrNk9NVlBuY01DU1licz0iLCJ6SURsYUNvZG9JUjNwbTNSVTlWOUJXaUJkZDJqenRMODAyN0VYTHhkWll3PSJdLCJzaWduYWxzIjp7fSwibWV0YSI6eyJ2IjoiNCIsImNoYWxsZW5nZV9pZCI6ImM4M2Q0ZTc5NTU2MjJmZjU3Mzc0ZDUzOTk2ZjliMmJhZGE2ZDQxZTMzNDM1ZjVlNzMyYjFmNmZjNmQ0ZTE1NzVoOGpidCIsInRpbWVzdGFtcCI6IjE3NTIxNTU3Nzc4NjYiLCJvcmlnaW4iOiJodHRwczovL2R1Y2tkdWNrZ28uY29tIiwic3RhY2siOiJFcnJvclxuYXQgRSAoaHR0cHM6Ly9kdWNrZHVja2dvLmNvbS9kaXN0L3dwbS5jaGF0LjcwZWFjYTZhZWEyOTQ4YjBiYjYwLmpzOjE6MTQ4MjUpXG5hdCBhc3luYyBodHRwczovL2R1Y2tkdWNrZ28uY29tL2Rpc3Qvd3BtLmNoYXQuNzBlYWNhNmFlYTI5NDhiMGJiNjAuanM6MToxNjk4NSIsImR1cmF0aW9uIjoiNTgifX0=";

const STATUS_URL = "https://duckduckgo.com/duckchat/v1/status";
const CHAT_URL = "https://duckduckgo.com/duckchat/v1/chat";

// VQD cache — refreshes on 418/429 or when the upstream response rotates
// the x-vqd-4 value. In-memory only (per process); restart loses it but
// the next chat request simply calls /status to repopulate.
let cachedVqd = null;
let cachedVqdExpiresAt = 0;
const VQD_TTL_MS = 5 * 60 * 1000; // 5 minutes

function browserHeaders() {
  return {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-store",
    DNT: "1",
    Priority: "u=1, i",
    Referer: "https://duckduckgo.com/",
    "Sec-CH-UA": SEC_CH_UA,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"Windows"`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Sec-GPC": "1",
    "User-Agent": USER_AGENT,
    "x-fe-version": X_FE_VERSION,
    "x-fe-signals": X_FE_SIGNALS,
  };
}

const ESSENTIAL_COOKIES = [
  { name: "5", value: "1" },
  { name: "dcm", value: "3" },
  { name: "dcs", value: "1" },
];

function buildCookieHeader() {
  return ESSENTIAL_COOKIES.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Fetch a fresh VQD from the /status endpoint. Cached for 5 minutes
 * because the upstream rotates it often but the cost of a forced refresh
 * is one extra round-trip. A 418/429 from /chat triggers a forced refresh
 * by clearing the cache before the retry.
 */
async function fetchVqd(signal, proxyOptions, log) {
  const now = Date.now();
  if (cachedVqd && now < cachedVqdExpiresAt) {
    return cachedVqd;
  }
  const res = await proxyAwareFetch(STATUS_URL, {
    method: "GET",
    signal,
    proxyOptions,
    headers: {
      ...browserHeaders(),
      "x-vqd-accept": "1",
    },
  }, log);
  if (!res.ok) {
    throw new Error(`DDG /status returned ${res.status} ${res.statusText}`);
  }
  // The README documents that the /status endpoint returns the dynamic
  // x-vqd-4 token in the `x-vqd-hash-1` response header. Confirmed in
  // the Go reference implementation. If this ever changes, the chat
  // endpoint will start returning 418 — the cache will refresh on the
  // next request and self-heal.
  const vqd = res.headers.get("x-vqd-hash-1") || res.headers.get("x-vqd-4");
  if (!vqd) {
    throw new Error("DDG /status did not return x-vqd-hash-1 — fingerprint may need refresh");
  }
  cachedVqd = vqd;
  cachedVqdExpiresAt = now + VQD_TTL_MS;
  return vqd;
}

/**
 * Force a VQD refresh on the next call (used by 418/429 retry).
 */
function invalidateVqd() {
  cachedVqd = null;
  cachedVqdExpiresAt = 0;
}

function buildChatPayload({ model, body, vqd }) {
  // The README documents this payload shape. We pass through the
  // client-supplied messages verbatim (with role/content per Message
  // struct), and let tool flags default to off.
  const messages = (body.messages || []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));
  return {
    model,
    metadata: {
      toolChoice: {
        NewsSearch: false,
        VideosSearch: false,
        LocalSearch: false,
        WeatherForecast: false,
      },
    },
    messages,
    canUseTools: false,
    canUseApproxLocation: false,
  };
}

class DuckduckgoWebExecutor extends BaseExecutor {
  constructor(config) {
    super(config?.id || "duckduckgo-web", config);
    // Provider is noAuth — DuckDuckGo gates by fingerprint, not apiKey.
    this.noAuth = true;
  }

  getProvider() {
    return "duckduckgo-web";
  }

  getBaseUrls() {
    return [CHAT_URL];
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    let vqd;
    try {
      vqd = await fetchVqd(signal, proxyOptions, log);
    } catch (err) {
      log?.error?.("DUCK", `VQD fetch failed: ${err.message}`);
      throw err;
    }

    const payload = buildChatPayload({ model, body, vqd });
    const headers = {
      ...browserHeaders(),
      "Content-Type": "application/json",
      Cookie: buildCookieHeader(),
      "x-fe-version": X_FE_VERSION,
      "x-fe-signals": X_FE_SIGNALS,
      "x-vqd-4": vqd,
      "x-vqd-hash-1": X_VQD_HASH_1,
      Origin: "https://duckduckgo.com",
      Referer: "https://duckduckgo.com/",
    };

    let res;
    try {
      res = await proxyAwareFetch(CHAT_URL, {
        method: "POST",
        signal,
        proxyOptions,
        headers,
        body: JSON.stringify(payload),
      }, log);
    } catch (err) {
      log?.error?.("DUCK", `Chat request failed: ${err.message}`);
      throw err;
    }

    // 418/429 → refresh VQD once and retry. Per the README, 418 is
    // "I'm a teapot" and means our fingerprint is rejected; a fresh VQD
    // resolves it because the static x-vqd-hash-1 was tied to a session
    // token that's now stale.
    if (res.status === 418 || res.status === 429) {
      invalidateVqd();
      try {
        vqd = await fetchVqd(signal, proxyOptions, log);
      } catch (err) {
        log?.error?.("DUCK", `VQD refresh failed: ${err.message}`);
        throw err;
      }
      headers["x-vqd-4"] = vqd;
      res = await proxyAwareFetch(CHAT_URL, {
        method: "POST",
        signal,
        proxyOptions,
        headers,
        body: JSON.stringify(payload),
      }, log);
    }

    if (!res.ok) {
      throw new Error(`DDG /chat returned ${res.status} ${res.statusText}`);
    }
    return res;
  }
}

export default DuckduckgoWebExecutor;

/**
 * Test-only: clear the in-process VQD cache so successive tests see
 * a clean slate. Not part of the public API surface; only used by the
 * unit suite.
 */
export function __resetVqdCacheForTests() {
  invalidateVqd();
}
