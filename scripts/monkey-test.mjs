#!/usr/bin/env node
/**
 * 🐵 888router Chaos Monkey Testing Tool
 * High-speed stress, fuzz, resilience, and chaos testing runner for 888router.
 *
 * Usage:
 *   node scripts/monkey-test.mjs [options]
 *   npm run test:monkey -- [options]
 *
 * Examples:
 *   node scripts/monkey-test.mjs --mode router --concurrency 10 --duration 15
 *   node scripts/monkey-test.mjs --mode mixed --concurrency 5 --requests 50 --verbose
 *   node scripts/monkey-test.mjs --mode fuzz --chaos high --concurrency 8 --duration 20
 */

import { performance } from "node:perf_hooks";
import crypto from "node:crypto";

// Default configuration
const DEFAULTS = {
  url: process.env.BASE_URL || "http://localhost:20128",
  key: process.env.API_KEY || "",
  concurrency: 5,
  duration: 15, // seconds (0 = use requests limit)
  requests: 0, // 0 = unlimited, bounded by duration
  rate: 20, // delay between worker requests in ms
  mode: "mixed", // 'router' (free/fast), 'fuzz' (malformed/chaos), 'llm' (real inference), 'mixed'
  chaos: "medium", // 'low', 'medium', 'high', 'insane'
  streamAbortRate: 0.15, // 15% of streams violently aborted mid-flight
  timeoutMs: 12000,
  verbose: false,
  dryRun: false,
};

// ANSI Terminal Colors
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// Parse command-line flags
export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--url") {
      options.url = next;
      i++;
    } else if (arg === "--key") {
      options.key = next;
      i++;
    } else if (arg === "-c" || arg === "--concurrency") {
      options.concurrency = Math.max(1, parseInt(next, 10) || 1);
      i++;
    } else if (arg === "-d" || arg === "--duration") {
      options.duration = Math.max(0, parseInt(next, 10) || 0);
      i++;
    } else if (arg === "-n" || arg === "--requests") {
      options.requests = Math.max(0, parseInt(next, 10) || 0);
      i++;
    } else if (arg === "--rate") {
      options.rate = Math.max(0, parseInt(next, 10) || 0);
      i++;
    } else if (arg === "-m" || arg === "--mode") {
      options.mode = ["router", "fuzz", "llm", "mixed"].includes(next) ? next : "mixed";
      i++;
    } else if (arg === "-x" || arg === "--chaos") {
      options.chaos = ["low", "medium", "high", "insane"].includes(next) ? next : "medium";
      i++;
    } else if (arg === "--stream-abort-rate") {
      options.streamAbortRate = Math.min(1, Math.max(0, parseFloat(next) || 0));
      i++;
    } else if (arg === "--models") {
      options.models = next.split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg === "-v" || arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  // Normalize URL (strip trailing slash)
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

function printHelp() {
  console.log(`
${C.bold}🐵 888router Chaos Monkey Test Suite${C.reset}

${C.yellow}Usage:${C.reset}
  node scripts/monkey-test.mjs [options]

${C.yellow}Options:${C.reset}
  ${C.green}--url <url>${C.reset}             Target 888router URL (default: http://localhost:20128)
  ${C.green}--key <key>${C.reset}             Bearer API key (default: active local key)
  ${C.green}-c, --concurrency <n>${C.reset}   Number of parallel monkey workers (default: 5)
  ${C.green}-d, --duration <sec>${C.reset}    Duration in seconds to run (default: 15, 0 = unlimited)
  ${C.green}-n, --requests <n>${C.reset}    Total request limit (default: 0 = duration-based)
  ${C.green}--rate <ms>${C.reset}             Throttle delay per worker between requests (default: 20ms)
  ${C.green}-m, --mode <mode>${C.reset}       Test mode:
                                ${C.cyan}router${C.reset} : Metadata, routing, DB load, parsers (Zero LLM cost)
                                ${C.cyan}fuzz${C.reset}   : Malformed JSON, huge payloads, 404s, invalid auth
                                ${C.cyan}llm${C.reset}    : Live inference, streaming, tokens, tool use
                                ${C.cyan}mixed${C.reset}  : 80% router/fuzz chaos + 20% live LLM (Default)
  ${C.green}-x, --chaos <level>${C.reset}     Chaos level: ${C.cyan}low${C.reset}, ${C.cyan}medium${C.reset}, ${C.cyan}high${C.reset}, ${C.cyan}insane${C.reset}
  ${C.green}--stream-abort-rate <r>${C.reset} Probability of abruptly aborting streams (default: 0.15)
  ${C.green}--models <list>${C.reset}         Comma-separated list of target models (auto-discovered if omitted)
  ${C.green}-v, --verbose${C.reset}           Print real-time individual request logs
  ${C.green}--dry-run${C.reset}               Verify connectivity and preview monkey plan without firing chaos
  ${C.green}-h, --help${C.reset}              Show this help message
`);
}

// Calculate Percentiles from an array of numbers
export function calculatePercentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

// Stats Collector
export class MonkeyStats {
  constructor(maxLatencySamples = 5000) {
    this.startTime = performance.now();
    this.total = 0;
    this.statusCounts = {};
    this.actionCounts = {};
    this.latencies = [];
    this.maxLatencySamples = maxLatencySamples;
    this.minLatency = Infinity;
    this.maxLatency = 0;
    this.latencySum = 0;
    this.latencyCount = 0;
    this.clientAborts = 0;
    this.networkErrors = 0;
    this.unexpected5xx = 0;
  }

  record(res) {
    this.total++;
    const status = res.status;
    const action = res.action || "UNKNOWN";

    this.actionCounts[action] = (this.actionCounts[action] || 0) + 1;

    if (res.aborted) {
      this.clientAborts++;
    } else if (res.networkError) {
      this.networkErrors++;
    } else if (status) {
      this.statusCounts[status] = (this.statusCounts[status] || 0) + 1;
      if (status >= 500) {
        this.unexpected5xx++;
      }
    }

    if (res.latencyMs !== undefined) {
      const lat = res.latencyMs;
      this.latencyCount++;
      this.latencySum += lat;
      if (lat < this.minLatency) this.minLatency = lat;
      if (lat > this.maxLatency) this.maxLatency = lat;

      if (this.latencies.length < this.maxLatencySamples) {
        this.latencies.push(lat);
      } else {
        const r = Math.floor(Math.random() * this.latencyCount);
        if (r < this.maxLatencySamples) {
          this.latencies[r] = lat;
        }
      }
    }
  }

  getSnapshot() {
    const elapsedSec = (performance.now() - this.startTime) / 1000;
    const rps = elapsedSec > 0 ? (this.total / elapsedSec).toFixed(1) : "0.0";

    const ok2xx = Object.entries(this.statusCounts)
      .filter(([code]) => code.startsWith("2"))
      .reduce((sum, [, count]) => sum + count, 0);

    const client4xx = Object.entries(this.statusCounts)
      .filter(([code]) => code.startsWith("4"))
      .reduce((sum, [, count]) => sum + count, 0);

    const server5xx = Object.entries(this.statusCounts)
      .filter(([code]) => code.startsWith("5"))
      .reduce((sum, [, count]) => sum + count, 0);

    return {
      total: this.total,
      elapsedSec: elapsedSec.toFixed(1),
      rps,
      ok2xx,
      client4xx,
      server5xx,
      clientAborts: this.clientAborts,
      networkErrors: this.networkErrors,
      p50: calculatePercentile(this.latencies, 50).toFixed(0),
      p90: calculatePercentile(this.latencies, 90).toFixed(0),
      p99: calculatePercentile(this.latencies, 99).toFixed(0),
      min: this.latencyCount > 0 ? this.minLatency.toFixed(0) : "0",
      max: this.latencyCount > 0 ? this.maxLatency.toFixed(0) : "0",
      avg: this.latencyCount > 0 ? (this.latencySum / this.latencyCount).toFixed(0) : "0",
      statusCounts: { ...this.statusCounts },
      actionCounts: { ...this.actionCounts },
    };
  }
}

// Request Generator for various Chaos Monkeys
export function generateMonkeyRequest({ mode, chaos, models = ["9-opus"], key, streamAbortRate = 0.15 }) {
  const chaosWeights = {
    low: { router: 70, fuzz: 10, llm: 20 },
    medium: { router: 50, fuzz: 30, llm: 20 },
    high: { router: 30, fuzz: 50, llm: 20 },
    insane: { router: 15, fuzz: 75, llm: 10 },
  };

  let category = "router";
  if (mode === "router") {
    category = "router";
  } else if (mode === "fuzz") {
    category = "fuzz";
  } else if (mode === "llm") {
    category = "llm";
  } else {
    // mixed mode: distribute based on chaos level
    const weights = chaosWeights[chaos] || chaosWeights.medium;
    const rand = Math.random() * 100;
    if (rand < weights.router) {
      category = "router";
    } else if (rand < weights.router + weights.fuzz) {
      category = "fuzz";
    } else {
      category = "llm";
    }
  }

  const randomModel = models[Math.floor(Math.random() * models.length)] || "9-opus";

  // --- ROUTER METADATA & REPO PROBES ---
  if (category === "router") {
    const routerActions = [
      {
        action: "ROUTER_VERSION",
        path: "/api/version",
        method: "GET",
        headers: {},
      },
      {
        action: "ROUTER_MODELS_OPENAI",
        path: "/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      },
      {
        action: "ROUTER_MODELS_INTERNAL",
        path: "/api/models",
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
      },
      {
        action: "ROUTER_TOKEN_SAVER_SUMMARY",
        path: `/api/usage/token-save-summary?days=${[7, 14, 30][Math.floor(Math.random() * 3)]}`,
        method: "GET",
        headers: {},
      },
      {
        action: "ROUTER_PROVIDERS",
        path: "/api/providers",
        method: "GET",
        headers: {},
      },
      {
        action: "ROUTER_SEARCH",
        path: "/v1/search",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: "monkey test " + crypto.randomBytes(4).toString("hex") }),
      },
    ];
    return routerActions[Math.floor(Math.random() * routerActions.length)];
  }

  // --- FUZZ & CHAOS ATTACK VECTORS ---
  if (category === "fuzz") {
    const fuzzActions = [
      {
        action: "FUZZ_MALFORMED_JSON",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: `{"model": "${randomModel}", "messages": [{"role": "user", "content": "unclosed json`,
      },
      {
        action: "FUZZ_EMPTY_MESSAGES",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: randomModel, messages: [] }),
      },
      {
        action: "FUZZ_NULL_CONTENT",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: randomModel, messages: [{ role: "user", content: null }] }),
      },
      {
        action: "FUZZ_OVERSIZED_PAYLOAD",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: randomModel,
          messages: [{ role: "user", content: "MONKEY_REPEAT_".repeat(2500) }], // ~35KB
          max_tokens: 1,
        }),
      },
      {
        action: "FUZZ_INVALID_MODEL",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: `nonexistent-chaos-model-${crypto.randomBytes(3).toString("hex")}`,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      },
      {
        action: "FUZZ_BAD_AUTH",
        path: "/v1/models",
        method: "GET",
        headers: { Authorization: "Bearer sk-invalid-garbage-token-999" },
      },
      {
        action: "FUZZ_404_ROUTE",
        path: `/__chaos_monkey__/${crypto.randomBytes(6).toString("hex")}`,
        method: "GET",
        headers: {},
      },
      {
        action: "FUZZ_NEGATIVE_PARAMS",
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: randomModel,
          messages: [{ role: "user", content: "hi" }],
          temperature: -5,
          max_tokens: -10,
        }),
      },
      {
        action: "FUZZ_ANTHROPIC_MISSING_MAX_TOKENS",
        path: "/v1/messages",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: randomModel,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    ];
    return fuzzActions[Math.floor(Math.random() * fuzzActions.length)];
  }

  // --- LIVE LLM INFERENCE & ABORT PROBES ---
  const isStream = Math.random() > 0.4;
  const shouldAbort = isStream && Math.random() < streamAbortRate;

  if (Math.random() > 0.5) {
    // Anthropic format
    return {
      action: shouldAbort ? "LLM_ANTHROPIC_STREAM_ABORT" : isStream ? "LLM_ANTHROPIC_STREAM" : "LLM_ANTHROPIC_SYNC",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: randomModel,
        stream: isStream,
        max_tokens: 10,
        messages: [{ role: "user", content: "reply 'ok' in one word" }],
      }),
      abortAfterMs: shouldAbort ? 120 : undefined,
    };
  }

  // OpenAI format
  return {
    action: shouldAbort ? "LLM_OPENAI_STREAM_ABORT" : isStream ? "LLM_OPENAI_STREAM" : "LLM_OPENAI_SYNC",
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: randomModel,
      stream: isStream,
      max_tokens: 10,
      messages: [{ role: "user", content: "reply 'ok' in one word" }],
    }),
    abortAfterMs: shouldAbort ? 120 : undefined,
  };
}

// Execute single HTTP request with latency timing and abort handling
export async function executeMonkeyRequest(req, baseUrl, timeoutMs = 12000) {
  const url = `${baseUrl}${req.path}`;
  const t0 = performance.now();
  const controller = new AbortController();
  const signal = controller.signal;

  let timer = null;
  let abortTimer = null;
  let abortReason = null;

  // Timeout guard
  timer = setTimeout(() => {
    abortReason = "timeout";
    controller.abort(new Error("Timeout"));
  }, timeoutMs);

  // Early client abort trigger (simulates sudden client disconnect mid-stream)
  if (req.abortAfterMs) {
    abortTimer = setTimeout(() => {
      abortReason = "client_abort";
      controller.abort(new Error("ClientAbortedMidStream"));
    }, req.abortAfterMs);
  }

  try {
    const res = await fetch(url, {
      method: req.method || "GET",
      headers: req.headers || {},
      body: req.body,
      signal,
    });

    // Consume body stream
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const latencyMs = performance.now() - t0;
    return {
      action: req.action,
      status: res.status,
      latencyMs,
      ok: res.ok,
      aborted: false,
    };
  } catch (err) {
    const latencyMs = performance.now() - t0;
    if (signal.aborted) {
      if (abortReason === "timeout") {
        return {
          action: req.action,
          status: 0,
          latencyMs,
          aborted: false,
          networkError: true,
          errorMsg: "RequestTimeout",
        };
      }
      return {
        action: req.action,
        status: 0,
        latencyMs,
        aborted: true,
        networkError: false,
        errorMsg: "ClientAbort",
      };
    }
    return {
      action: req.action,
      status: 0,
      latencyMs,
      aborted: false,
      networkError: true,
      errorMsg: err.message,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortTimer) clearTimeout(abortTimer);
  }
}

// Health check to ensure 888router is still operational
export async function checkServerLiveness(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.currentVersion;
  } catch {
    return false;
  }
}

// Auto-discover available models from 888router
export async function discoverModels(baseUrl, key) {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json = await res.json();
      const list = (json.data || []).map((m) => m.id).filter(Boolean);
      if (list.length) return list.slice(0, 10);
    }
  } catch {
    // ignore
  }
  return ["9-opus", "auto"];
}

// Main Interactive Runner
async function main() {
  const options = parseArgs();

  console.log(`
${C.bold}${C.magenta}======================================================${C.reset}
${C.bold}${C.magenta}🐵 888router CHAOS MONKEY STRESS & RESILIENCE RUNNER 🐵${C.reset}
${C.bold}${C.magenta}======================================================${C.reset}
  ${C.bold}Target:${C.reset}       ${C.cyan}${options.url}${C.reset}
  ${C.bold}Mode:${C.reset}         ${C.yellow}${options.mode.toUpperCase()}${C.reset} (Chaos: ${C.yellow}${options.chaos}${C.reset})
  ${C.bold}Concurrency:${C.reset}  ${options.concurrency} parallel workers
  ${C.bold}Duration:${C.reset}     ${options.duration > 0 ? `${options.duration}s` : "Unlimited"} ${options.requests > 0 ? `(Cap: ${options.requests} reqs)` : ""}
  ${C.bold}Throttle:${C.reset}     ${options.rate}ms delay/worker
  ${C.bold}Stream Abort:${C.reset} ${(options.streamAbortRate * 100).toFixed(0)}% probability
`);

  // Pre-flight liveness check
  process.stdout.write(`${C.dim}Connecting to 888router at ${options.url}... ${C.reset}`);
  const isAlive = await checkServerLiveness(options.url);
  if (!isAlive) {
    console.log(`${C.red}FAILED!${C.reset}`);
    console.error(`${C.red}Error: 888router is unreachable at ${options.url}. Please ensure container is running.${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}CONNECTED (Healthy)!${C.reset}`);

  // Model discovery
  let models = options.models;
  if (!models || !models.length) {
    process.stdout.write(`${C.dim}Discovering active models/combos... ${C.reset}`);
    models = await discoverModels(options.url, options.key);
    console.log(`${C.cyan}${models.join(", ")}${C.reset}`);
  }

  if (options.dryRun) {
    console.log(`\n${C.yellow}--- DRY RUN PREVIEW ---${C.reset}`);
    for (let i = 0; i < 5; i++) {
      const sample = generateMonkeyRequest({ ...options, models });
      console.log(`[Sample ${i + 1}] ${sample.method} ${sample.path} (${sample.action})`);
    }
    console.log(`\n${C.green}Dry run complete. No chaos requests sent.${C.reset}`);
    process.exit(0);
  }

  console.log(`\n${C.bold}🔥 UNLEASHING MONKEYS...${C.reset}\n`);

  const stats = new MonkeyStats();
  const startTime = performance.now();
  let stopRequested = false;

  // Handle SIGINT cleanly
  process.on("SIGINT", () => {
    if (stopRequested) process.exit(1);
    console.log(`\n${C.yellow}Stopping monkeys, waiting for workers to drain...${C.reset}`);
    stopRequested = true;
  });

  // HUD Update Timer
  let hudInterval = null;
  if (!options.verbose) {
    hudInterval = setInterval(() => {
      const snap = stats.getSnapshot();
      const elapsed = parseFloat(snap.elapsedSec);
      const remaining = options.duration > 0 ? Math.max(0, options.duration - elapsed).toFixed(0) : "∞";

      process.stdout.write(
        `\r[${C.bold}${elapsed.toFixed(0)}s${C.reset} / rem: ${remaining}s] ` +
        `Reqs: ${C.cyan}${snap.total}${C.reset} | ` +
        `RPS: ${C.green}${snap.rps}${C.reset} | ` +
        `2xx: ${C.green}${snap.ok2xx}${C.reset} | ` +
        `4xx: ${C.yellow}${snap.client4xx}${C.reset} | ` +
        `5xx: ${snap.server5xx > 0 ? C.red : C.green}${snap.server5xx}${C.reset} | ` +
        `Aborts: ${C.magenta}${snap.clientAborts}${C.reset} | ` +
        `P90: ${snap.p90}ms  `
      );
    }, 150);
  }

  // Worker loop with atomic request reservation
  let reservedRequests = 0;
  function reserveRequestSlot() {
    if (options.requests > 0) {
      if (reservedRequests >= options.requests) return false;
      reservedRequests++;
      return true;
    }
    return true;
  }

  async function worker(workerId) {
    while (!stopRequested) {
      // Check duration limit
      if (options.duration > 0 && (performance.now() - startTime) / 1000 >= options.duration) {
        break;
      }
      // Check request limit
      if (!reserveRequestSlot()) {
        break;
      }

      const req = generateMonkeyRequest({ ...options, models });
      const res = await executeMonkeyRequest(req, options.url, options.timeoutMs);
      stats.record(res);

      if (options.verbose) {
        const statusColor = res.aborted
          ? C.magenta
          : res.status >= 500
          ? C.red
          : res.status >= 400
          ? C.yellow
          : C.green;
        const statusLabel = res.aborted ? "ABORT" : res.status || "ERR";
        console.log(
          `[W${workerId}] ${statusColor}${statusLabel}${C.reset} (${res.latencyMs.toFixed(0)}ms) - ${req.action} ${req.path}`
        );
      }

      if (options.rate > 0) {
        await new Promise((r) => setTimeout(r, options.rate));
      }
    }
  }

  // Launch parallel workers
  const workerPromises = [];
  for (let i = 1; i <= options.concurrency; i++) {
    workerPromises.push(worker(i));
  }

  await Promise.all(workerPromises);
  if (hudInterval) clearInterval(hudInterval);

  console.log(`\n\n${C.bold}🔍 RUNNING POST-MORTEM HEALTH CHECK...${C.reset}`);
  const postLiveness = await checkServerLiveness(options.url);

  // Final Summary Report
  const final = stats.getSnapshot();
  console.log(`
${C.bold}${C.cyan}======================================================${C.reset}
${C.bold}${C.cyan}               📊 MONKEY TEST FINAL REPORT            ${C.reset}
${C.bold}${C.cyan}======================================================${C.reset}
  ${C.bold}Total Requests:${C.reset}     ${C.cyan}${final.total}${C.reset}
  ${C.bold}Duration:${C.reset}           ${final.elapsedSec} seconds
  ${C.bold}Throughput:${C.reset}         ${C.green}${final.rps} req/sec${C.reset}

  ${C.bold}HTTP Status Breakdown:${C.reset}
    ${C.green}2xx (Success):${C.reset}        ${final.ok2xx}
    ${C.yellow}4xx (Fuzz/Rejected):${C.reset}  ${final.client4xx}
    ${final.server5xx > 0 ? C.red : C.green}5xx (Server Error):${C.reset}   ${final.server5xx}
    ${C.magenta}Client Aborts:${C.reset}        ${final.clientAborts}
    ${C.red}Network/Timeout:${C.reset}     ${final.networkErrors}

  ${C.bold}Latency Distribution (ms):${C.reset}
    Min: ${final.min}ms | Avg: ${final.avg}ms | P50: ${final.p50}ms | P90: ${final.p90}ms | P99: ${final.p99}ms | Max: ${final.max}ms

  ${C.bold}Post-Test Server Health:${C.reset}
    ${postLiveness ? `${C.green}✅ 888router is 100% ALIVE and RESPONSIVE${C.reset}` : `${C.red}❌ 888router is UNRESPONSIVE / CRASHED${C.reset}`}
`);

  // Action counts breakdown
  console.log(`${C.bold}Attack Vector Coverage:${C.reset}`);
  for (const [action, count] of Object.entries(final.actionCounts)) {
    console.log(`  - ${action.padEnd(32)}: ${count}`);
  }

  console.log(`\n${C.bold}------------------------------------------------------${C.reset}`);
  if (postLiveness && final.server5xx === 0 && final.networkErrors === 0) {
    console.log(`${C.bold}${C.green}🏆 VERDICT: PASS — 888router is Rock Solid under Chaos!${C.reset}\n`);
    process.exit(0);
  } else if (!postLiveness) {
    console.log(`${C.bold}${C.red}💥 VERDICT: FAIL — Server became unresponsive!${C.reset}\n`);
    process.exit(1);
  } else {
    console.log(`${C.bold}${C.red}💥 VERDICT: FAIL — Detected ${final.server5xx} 5xx errors and ${final.networkErrors} network errors!${C.reset}\n`);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] && process.argv[1].endsWith("monkey-test.mjs")) {
  main().catch((err) => {
    console.error(`\n${C.red}Fatal Error in Monkey Runner: ${err.message}${C.reset}`);
    process.exit(1);
  });
}
