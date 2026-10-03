import { CODEX_CLI_VERSION } from "../providers/shared.js";

// The official package's latest stable release drives the version-gated catalog.
const RELEASE_URL = "https://registry.npmjs.org/@openai/codex/latest";
const RETRY_DELAY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

let cachedVersion = CODEX_CLI_VERSION;
let retryAt = 0;
let warning;
let pending;

function isCurrentStableVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const candidate = value.split(".").map(Number);
  const baseline = cachedVersion.split(".").map(Number);
  for (let i = 0; i < baseline.length; i++) {
    if (candidate[i] !== baseline[i]) return candidate[i] > baseline[i];
  }
  return true;
}

async function refreshVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Public metadata request: never attach provider credentials.
    const response = await fetch(RELEASE_URL, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("Codex release metadata unavailable");
    const release = await response.json();
    if (release.name !== "@openai/codex" || !isCurrentStableVersion(release.version)) {
      throw new Error("Invalid Codex release metadata");
    }
    cachedVersion = release.version;
    warning = undefined;
    retryAt = 0;
  } catch {
    warning = "Could not refresh the Codex release version. Using the last known version; newly released models may be missing. Retry Sync shortly.";
    retryAt = Date.now() + RETRY_DELAY_MS;
  } finally {
    clearTimeout(timer);
  }
  return { version: cachedVersion, warning };
}

export async function resolveCodexDiscoveryVersion() {
  // Each Sync checks the release again; cache only for outage backoff/fallback.
  if (Date.now() < retryAt) return { version: cachedVersion, warning };
  if (!pending) {
    pending = refreshVersion().finally(() => { pending = undefined; });
  }
  return pending;
}
