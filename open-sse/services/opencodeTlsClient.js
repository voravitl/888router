// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// Ported from upstream decolua/9router ce060c79b (+ the per-proxy routing of
// open PR decolua/9router#5297). The free gate keys on the TLS ClientHello,
// not only on headers: on one process and one egress IP the same body/headers
// answered 429 FreeUsageLimitError over Node's OpenSSL fingerprint and 200 over
// a wreq-js session sending the cipher list below (upstream probes 2026-10-26;
// re-confirmed here 2026-10-29, probe receipts #1 native 429 vs #2/#4 wreq 200).
// JA4's cipher hash identifies the list, so only the list's hash matters —
// reordering the same list still passes, dropping any entry fails.
//
// wreq-js is bundled into the image; when it cannot be loaded the caller keeps
// its native fetch (fail-open, logged by proxyFetch) and stays subject to the
// gate rather than failing the request here.

import { loadRuntimeDep } from "./lazyRuntime.js";

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const DEFAULT_TIMEOUT_MS = 120000;
// One impersonated session per proxy URL ("" = direct). wreq-js 3.2.0 refuses a
// per-request `proxy` on a session-bound fetch ("Session proxy cannot be
// changed after creation"), so the proxy is fixed when the session is created.
const MAX_SESSIONS = 16;
const sessions = new Map();

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

function loadSession(proxyUrl) {
  const key = proxyUrl || "";
  let pending = sessions.get(key);
  if (!pending) {
    pending = (async () => {
      const wreq = await loadRuntimeDep("wreq-js");
      if (typeof wreq?.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      const options = { emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } } };
      if (key) options.proxy = key;
      return wreq.createSession(options);
    })();
    pending.catch(() => {
      if (sessions.get(key) === pending) sessions.delete(key);
    });
    if (sessions.size >= MAX_SESSIONS) {
      const oldestKey = sessions.keys().next().value;
      const oldest = sessions.get(oldestKey);
      sessions.delete(oldestKey);
      oldest?.then((s) => s?.close?.()).catch(() => {});
    }
    sessions.set(key, pending);
  }
  return pending;
}

/** Drop every cached session so the next call builds fresh ones. */
export function resetOpencodeTlsSession() {
  const pending = [...sessions.values()];
  sessions.clear();
  for (const p of pending) p.then((s) => s?.close?.()).catch(() => {});
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 * Streaming is preserved: the response body is handed over as the live
 * ReadableStream, never buffered.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: any}} init
 * @param {{signal?: AbortSignal, timeoutMs?: number, proxyUrl?: string|null}} [opts]
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxyUrl = null } = {}) {
  let session;
  try {
    session = await loadSession(proxyUrl);
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — the OpenCode free tier needs the bundled wreq-js TLS client`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
