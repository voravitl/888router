// Host-probe helper for golden-url-header.test.js.
//
// Dumps the header set for every golden provider so the test can compare TWO
// runs of the same code: one on the real host, one with every source of host
// identity replaced by a canary.
//
// The canary is applied through a `--require` preload that patches BOTH
// `os.platform/arch/hostname()` and `process.platform/arch/version`
// BEFORE the application modules are imported. That matters because
// open-sse/providers/shared.js and open-sse/config/appConstants.js call
// `os.platform()` / `os.arch()` / `os.hostname()` at MODULE LOAD time, so
// patching them afterwards inside the same process would not change the
// already-captured bindings.
//
// Run as:  node tests/translator/golden-url-header.host-probe.mjs
// Output:  one JSON object on stdout.

import { hostname } from "node:os";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { sanitize } from "./golden-url-header.sanitize.mjs";

const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };

const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "qwen", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "chatgpt-web", "zenmux-free", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
  "aipass", "aipass-th", "aipass-bridge", "ap",
]);

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

const out = {};
for (const pid of providerIds) {
  const ex = new DefaultExecutor(pid);
  const variants = {
    apiKey: safe(() => ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true)),
    oauth: safe(() => ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true)),
    nonStream: safe(() => ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false)),
  };
  for (const [variant, headers] of Object.entries(variants)) {
    if (typeof headers !== "object" || headers === null) continue;
    // Sanitized here, with the SAME implementation the snapshot test uses.
    // The guard compares two runs of this file — one on the real host, one
    // under the canary — so a host-dependent value that survives
    // sanitize() shows up as a difference between the two runs.
    const clean = sanitize(headers);
    for (const [k, v] of Object.entries(clean)) {
      if (typeof v !== "string") continue;
      out[`${pid} (${variant}) ${k}`] = v;
    }
  }
}

const payload = {
  headers: out,
  host: {
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    hostname: hostname(),
  },
};

process.stdout.write(JSON.stringify(payload));
