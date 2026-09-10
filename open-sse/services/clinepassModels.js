import { buildClineHeaders } from "../shared/clineAuth.js";

const CLINEPASS_MODELS_ENDPOINT = "https://api.cline.bot/api/v1/models";
const FETCH_TIMEOUT_MS = 5000;
// 2MB catalog cap enforced on the STREAMED byte count (not decoded string
// length): the live list is ~100KB; anything larger is abuse or corruption.
// content-length is advisory only — the stream cap is the real enforcement
// (compressed bodies can expand far beyond declared length).
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
// Cap accepted models: scan at most this many raw records, keep at most this
// many valid ones. Malformed leading records can't starve valid tail entries.
const MAX_RAW_RECORDS = 5000;
const MAX_MODELS = 1000;
// Strict segment grammar: lowercase alnum start, then alnum + . _ - and at
// most one trailing :suffix (the :free / :batch variant marker — part of the
// model id, not a path). Rejects ../, .., query (?), fragment (#),
// backslash, %, whitespace, multi-colon, uppercase (live catalog is
// all-lowercase; uppercase is rejected, never normalized, so ids can't
// collide or spoof across case).
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/;

/**
 * Read a bounded body from a fetch Response: enforce MAX_CATALOG_BYTES on
 * actual streamed bytes (cancel immediately over the limit), then decode.
 * Fail-closed when streaming is unavailable: response.text() would buffer
 * unboundedly, so a body without getReader is rejected in production. Tests
 * inject a real ReadableStream body (see clinepass-live-catalog.test.js).
 */
async function readBoundedText(response) {
  if (!response.body?.getReader) {
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      // Defensive: a non-Uint8Array chunk would break byteLength math and
      // the concat below — treat as stream failure, cancel, fail closed.
      if (!(value instanceof Uint8Array)) break;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) break; // cancel in finally below
      chunks.push(value);
    }
  } catch {
    // Network/abort/read error: fall through to cancel + null below,
    // preserving fail-closed semantics without masking the path.
  } finally {
    // Cancel on EVERY incomplete path (size overrun, read throw, non-byte
    // chunk) — releasing the lock alone doesn't free the connection.
    if (!completed) {
      await reader.cancel("catalog incomplete").catch(() => {});
    }
    reader.releaseLock();
  }
  if (!completed) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/**
 * Build request headers for the ClinePass /models endpoint (Cline's upstream API).
 * - API keys are sent as plain Bearer tokens.
 * - OAuth access tokens must carry the WorkOS `workos:` prefix (handled by buildClineHeaders).
 */
function buildModelListHeaders(token, isApiKey) {
  if (isApiKey) {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
  }
  return buildClineHeaders(token, { Accept: "application/json" });
}

/**
 * Fetch ClinePass live model catalog from Cline's /models endpoint.
 *
 * @param {object} credentials - Connection credentials ({ accessToken, apiKey })
 * @returns {Promise<{ models: { id: string, name: string }[] } | null>}
 */
export async function resolveClinepassModels(credentials) {
  const isApiKey = Boolean(credentials?.apiKey);
  const token = isApiKey ? credentials.apiKey : credentials?.accessToken;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers = buildModelListHeaders(token, isApiKey);

    const response = await fetch(CLINEPASS_MODELS_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return null;
    }

    // Advisory content-length gate (strict parse: canonical non-negative
    // safe integer only; malformed values fall through to the stream cap).
    // Body is cancelled immediately — never buffered unbounded.
    const rawLength = response.headers?.get?.("content-length");
    if (rawLength !== null && rawLength !== undefined) {
      const declared = Number(rawLength);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_CATALOG_BYTES) {
        await response.body?.cancel?.().catch(() => {});
        return null;
      }
    }
    const text = await readBoundedText(response);
    if (text === null) return null;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const rawList = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(rawList)) return null;

    // Live catalog ids are bare `provider/model` (e.g.
    // `inclusionai/ling-3.0-flash-fin:free`, `deepseek/deepseek-v4.1-flash`) —
    // the `cline-pass/` prefix exists only in models.dev, never on the wire.
    // Strict schema (mirrors opencodeGoModels.normalizeOpenCodeGoModel):
    // trim, <=256 chars, no control chars, single provider/model shape
    // (exactly one `/`, non-empty sides), dedupe, drop malformed. Bound
    // input at 1000 records. The chat executor prefixes the provider at
    // request time.
    const seen = new Set();
    const models = [];
    let inspected = 0;
    for (const m of rawList) {
      if (++inspected > MAX_RAW_RECORDS) break;
      if (models.length >= MAX_MODELS) break;
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      if (!id || id.length > 256 || seen.has(id)) continue;
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1F\x7F]/.test(id)) continue;
      const parts = id.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      // Strict segment grammar on the RAW id (no lowercasing — live catalog
      // is all-lowercase; uppercase is rejected, not normalized, so a
      // differently-cased id can never collide or spoof).
      if (!SEGMENT_RE.test(parts[0]) || !SEGMENT_RE.test(parts[1])) continue;
      seen.add(id);
      const rawName = typeof m?.name === "string" ? m.name.trim() : "";
      // Strip ASCII + C1 controls and bidi/isolate formatting (log/UI spoof).
      const cleanName = rawName
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1F\x7F-\x9F‪-‮⁦-⁩]/g, "")
        .trim()
        .slice(0, 512);
      models.push({ id, name: cleanName || id });
    }

    return models.length ? { models } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
