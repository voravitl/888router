import fs from "node:fs";
import path from "node:path";

const HOSTS_CACHE_TTL_MS = 5000;
let cachedHosts = { readAt: 0, content: null };

function getHostsFilePath() {
  if (process.platform === "win32") {
    return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts");
  }
  return "/etc/hosts";
}

function readHostsFileCached() {
  const now = Date.now();
  if (cachedHosts.content !== null && now - cachedHosts.readAt < HOSTS_CACHE_TTL_MS) {
    return cachedHosts.content;
  }
  try {
    const content = fs.readFileSync(getHostsFilePath(), "utf8");
    cachedHosts = { readAt: now, content };
    return content;
  } catch {
    cachedHosts = { readAt: now, content: "" };
    return "";
  }
}

export function clearMitmLoopHeaderCache() {
  cachedHosts = { readAt: 0, content: null };
}

export function extractTargetHostname(targetUrlOrHost) {
  if (typeof targetUrlOrHost !== "string") return "";
  const trimmed = targetUrlOrHost.trim();
  if (!trimmed) return "";
  try {
    if (trimmed.includes("://")) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return "";
  }
  return trimmed.split("/")[0].split(":")[0].toLowerCase();
}

/**
 * Pure check: returns true only if an active (uncommented) loopback entry
 * (`127.0.0.1` or `::1`) maps `targetHost` in hosts-file text.
 */
export function parseHostsRedirectMatch(hostsContent, targetHost) {
  const host = extractTargetHostname(targetHost);
  if (!host || typeof hostsContent !== "string" || !hostsContent) return false;

  for (const rawLine of hostsContent.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const tokens = line.toLowerCase().split(/\s+/);
    if (tokens.length < 2) continue;
    if (tokens[0] !== "127.0.0.1" && tokens[0] !== "::1") continue;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === host) return true;
    }
  }
  return false;
}

/**
 * Attach internal anti-loop header (`x-request-source: local`) ONLY when the local
 * hosts file actively redirects `targetUrlOrHost` to loopback MITM. Prevents leaking
 * an internal 888router header directly to Google when running standalone or in Docker.
 */
export function shouldSendMitmLoopHeader(targetUrlOrHost, hostsContentOverride = null) {
  const host = extractTargetHostname(targetUrlOrHost);
  if (!host) return false;
  const content = typeof hostsContentOverride === "string"
    ? hostsContentOverride
    : readHostsFileCached();
  return parseHostsRedirectMatch(content, host);
}
