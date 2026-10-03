#!/usr/bin/env node
/**
 * Small, synthetic A/B smoke test for Claude Code compatible routes.
 * Reads credentials from the live 888route SQLite DB in memory and prints only
 * timings, status, returned model, and task pass/fail. Never prints prompts,
 * credentials, headers, or response text.
 */
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const ROUTER = process.env.ROUTER_URL || "http://localhost:20129";
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || 90_000);
const phase = process.env.BENCH_PHASE || "unspecified";
const thinkingMode = process.env.BENCH_THINKING || "default";
const effort = process.env.BENCH_EFFORT || null;
const rounds = [
  { route: "cc-opus", kind: "text", model: "claude-opus-5-5" },
  { route: "direct", kind: "text", model: "claude-opus-5-5" },
  { route: "cc-opus", kind: "tool", model: "claude-opus-5-5" },
  { route: "direct", kind: "tool", model: "claude-opus-5-5" },
  { route: "cc-sonnet", kind: "text", model: "claude-sonnet-5-5" },
  { route: "direct", kind: "text", model: "claude-sonnet-5-5" },
  { route: "cc-sonnet", kind: "tool", model: "claude-sonnet-5-5" },
  { route: "direct", kind: "tool", model: "claude-sonnet-5-5" },
  { route: "9-sonnet", kind: "text", model: null },
];

function liveCredentials() {
  const source = String.raw`const D=require('better-sqlite3');const d=new D('/app/data/db/data.sqlite',{readonly:true,fileMustExist:true});const k=d.prepare('SELECT key FROM apiKeys WHERE isActive=1 ORDER BY createdAt ASC LIMIT 1').get();const c=d.prepare("SELECT id,provider,authType,data FROM providerConnections WHERE provider='claude' AND isActive=1 ORDER BY COALESCE(priority,999),updatedAt DESC LIMIT 1").get();if(!k||!c)process.exit(3);const x=JSON.parse(c.data||'{}');process.stdout.write(JSON.stringify({routerKey:k.key,claude:{id:c.id,authType:c.authType,accessToken:x.accessToken,apiKey:x.apiKey}}));`;
  const raw = execFileSync("docker", ["compose", "exec", "-T", "888route", "node", "-e", source], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const value = JSON.parse(raw);
  if (!value.routerKey || (!value.claude.accessToken && !value.claude.apiKey)) throw new Error("required live connection unavailable");
  return value;
}

function requestBody(kind, model, nonce) {
  const body = {
    model,
    max_tokens: 256,
    stream: true,
    messages: [{ role: "user", content: kind === "text"
      ? `For this diagnostic ${nonce}, reply with exactly ROUTE_BENCH_OK and no other text.`
      : `For this diagnostic ${nonce}, call the diagnostic tool exactly once with value 17. Do not answer in text.` }],
  };
  if (thinkingMode !== "default") body.thinking = { type: thinkingMode };
  if (effort) body.output_config = { effort };
  if (kind === "tool") {
    body.tools = [{ name: "diagnostic_echo", description: "Diagnostic tool; return no private data.", input_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } }];
    body.tool_choice = { type: "auto" };
  }
  return body;
}

function requestModel(item) {
  return item.route === "direct" ? item.model : item.route;
}

function matchingCombo(results, directResult) {
  return results.find((result) => result.route.startsWith("cc-") && result.expectedUpstreamModel === directResult.expectedUpstreamModel && result.task === directResult.task);
}

function sseMetrics(text, kind) {
  const events = text.split(/\r?\n\r?\n/);
  let output = "";
  const toolBlocks = new Map();
  let err = false;
  let complete = false;
  let toolUseCount = 0;
  for (const event of events) {
    const data = event.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "error" || parsed.error) err = true;
      if (parsed.type === "message_stop") complete = true;
      for (const block of parsed.content || []) {
        if (block.type === "text" && block.text) output += block.text;
      }
      if (parsed.type === "content_block_delta") {
        if (parsed.delta?.text) output += parsed.delta.text;
        if (parsed.delta?.type === "input_json_delta" && Number.isInteger(parsed.index)) {
          const block = toolBlocks.get(parsed.index);
          if (block) block.partial += parsed.delta.partial_json || "";
        }
      }
      if (parsed.type === "content_block_start" && Number.isInteger(parsed.index)) {
        toolBlocks.set(parsed.index, { type: parsed.content_block?.type, name: parsed.content_block?.name, input: parsed.content_block?.input, partial: "" });
        if (parsed.content_block?.type === "tool_use") toolUseCount++;
      }
    } catch { /* Ignore malformed or non-JSON event lines; status is retained. */ }
  }
  const validTool = [...toolBlocks.values()].some((block) => {
    let input = block.input;
    if ((!input || Object.keys(input).length === 0) && block.partial) {
      try { input = JSON.parse(block.partial); } catch { return false; }
    }
    return block.type === "tool_use" && block.name === "diagnostic_echo" && input?.value === 17 && Number.isInteger(input.value);
  });
  const taskPassed = kind === "text" ? output.trim() === "ROUTE_BENCH_OK" : toolUseCount === 1 && validTool;
  return { pass: taskPassed && complete && !err, streamError: err, complete, toolUseCount };
}

function containsFirstUsefulEvent(rawEvent) {
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      const value = JSON.parse(line.slice(6));
      if (value.type === "content_block_start" && value.content_block?.type === "tool_use") return true;
      if (value.type === "content_block_delta" && typeof value.delta?.text === "string" && value.delta.text.length) return true;
      if (Array.isArray(value.choices) && value.choices.some((choice) => typeof choice.delta?.content === "string" && choice.delta.content.length)) return true;
    } catch { /* incomplete chunk; check when the next delimiter arrives */ }
  }
  return false;
}

function runParserChecks() {
  const sse = (...events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n");
  const text = sse(
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ROUTE_BENCH_OK" } },
    { type: "message_stop" },
  );
  assert.equal(requestModel({ route: "cc-opus", model: "claude-opus-5-5" }), "cc-opus", "combo requests must send the combo alias");
  assert.equal(requestModel({ route: "direct", model: "claude-opus-5-5" }), "claude-opus-5-5", "direct requests send the upstream model");
  assert.equal(matchingCombo([
    { route: "cc-opus", expectedUpstreamModel: "claude-opus-5-5", task: "text" },
    { route: "cc-opus", expectedUpstreamModel: "claude-opus-5-5", task: "tool" },
  ], { expectedUpstreamModel: "claude-opus-5-5", task: "tool" }).task, "tool", "text and tool trials must remain separate pairs");
  assert.deepEqual(sseMetrics(text, "text"), { pass: true, streamError: false, complete: true, toolUseCount: 0 });
  assert.equal(sseMetrics(text.replace(/\n\nevent: message_stop[\s\S]*$/, ""), "text").pass, false, "message_stop is required");
  const toolStart = (index, input = {}) => ({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "diagnostic_echo", input } });
  const oneTool = sse(toolStart(0), { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ value: 17 }) } }, { type: "message_stop" });
  assert.deepEqual(sseMetrics(oneTool, "tool"), { pass: true, streamError: false, complete: true, toolUseCount: 1 });
  assert.equal(sseMetrics(sse(toolStart(0, { value: 17 }), toolStart(1, { value: 17 }), { type: "message_stop" }), "tool").pass, false, "exactly one tool call is required");
  assert.equal(sseMetrics(sse(toolStart(0, { value: "17" }), { type: "message_stop" }), "tool").pass, false, "tool arguments must match the schema");
  assert.equal(containsFirstUsefulEvent(sse(toolStart(0))), true, "tool start is a useful event");
  assert.equal(containsFirstUsefulEvent(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })), false, "empty text block is not useful content");
}

function routeResolution(since, comboName, prompt) {
  const source = String.raw`const D=require('better-sqlite3');const d=new D('/app/data/db/data.sqlite',{readonly:true,fileMustExist:true});const rows=d.prepare("SELECT timestamp,provider,model,connectionId,status,json_extract(data,'$.clientModel') AS clientModel FROM requestDetails WHERE timestamp>=? AND json_extract(data,'$.request.messages[0].content')=? ORDER BY timestamp DESC LIMIT 10").all(process.argv[1],process.argv[2]);process.stdout.write(JSON.stringify(rows));`;
  try {
    const raw = execFileSync("docker", ["compose", "exec", "-T", "888route", "node", "-e", source, since, prompt], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(raw).filter((row) => row.clientModel === comboName).reverse().map((row) => ({ provider: row.provider, model: row.model, status: row.status, sameClaudeAccount: row.connectionId === currentClaudeConnectionId }));
  } catch { return []; }
}

function safeErrorKind(value) {
  const root = value?.error ?? value;
  const type = typeof root?.type === "string" ? root.type.toLowerCase() : "";
  const message = typeof root?.message === "string" ? root.message.toLowerCase() : "";
  if (/auth|credential|token|api.?key/.test(`${type} ${message}`)) return "auth_rejected";
  if (/model|not_found/.test(`${type} ${message}`)) return "model_rejected";
  if (/rate|quota|credit/.test(`${type} ${message}`)) return "rate_or_quota";
  if (/tool|schema|input|request|invalid/.test(`${type} ${message}`)) return "request_rejected";
  if (/overload|server|internal/.test(`${type} ${message}`)) return "upstream_error";
  return "unspecified_error";
}

async function run(item, creds) {
  const direct = item.route === "direct";
  const url = direct ? "https://api.anthropic.com/v1/messages?beta=true" : `${ROUTER}/v1/messages`;
  const model = requestModel(item);
  const prompt = item.kind === "text"
    ? `For this diagnostic ${item.nonce}, reply with exactly ROUTE_BENCH_OK and no other text.`
    : `For this diagnostic ${item.nonce}, call the diagnostic tool exactly once with value 17. Do not answer in text.`;
  const body = requestBody(item.kind, model, item.nonce);
  const clientHeaders = {
    "content-type": "application/json", accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": `claude-cli/${claudeCliVersionNumber} (external, sdk-cli)`, "x-app": "cli",
    "x-stainless-helper-method": "stream", "x-stainless-retry-count": "0",
    "x-stainless-runtime-version": "v24.14.0", "x-stainless-package-version": "0.80.0",
    "x-stainless-runtime": "node", "x-stainless-lang": "js", "x-stainless-arch": "arm64",
    "x-stainless-os": "MacOS", "x-stainless-timeout": "600",
  };
  const headers = direct
    ? {
      ...clientHeaders,
      ...(creds.claude.apiKey ? { "x-api-key": creds.claude.apiKey } : { authorization: `Bearer ${creds.claude.accessToken}` }),
    }
    : { ...clientHeaders, "x-api-key": creds.routerKey };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  let headerMs = null;
  let firstByteMs = null;
  let responseText = "";
  let status = 0;
  let returnedModel = null;
  let errorKind = null;
  let safeError = null;
  let firstUsefulMs = null;
  let eventBuffer = "";
  const since = new Date().toISOString();
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    headerMs = Math.round(performance.now() - start);
    status = response.status;
    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstByteMs == null) firstByteMs = Math.round(performance.now() - start);
        const decoded = decoder.decode(value, { stream: true });
        responseText += decoded;
        eventBuffer += decoded;
        if (firstUsefulMs == null) {
          const completeEvents = eventBuffer.split(/\r?\n\r?\n/);
          if (completeEvents.slice(0, -1).some(containsFirstUsefulEvent)) firstUsefulMs = Math.round(performance.now() - start);
          eventBuffer = completeEvents.at(-1);
        }
        // Cap captured body; test replies are tiny and we never retain arbitrary upstream payloads.
        if (responseText.length > 64_000) { await reader.cancel(); break; }
      }
    } else {
      // Read only into memory to classify the failure; never emit its text.
      const rawError = await response.text();
      try { const details = JSON.parse(rawError); errorKind = safeErrorKind(details); safeError = { errorType: details?.error?.type || details?.type || null }; } catch { errorKind = "non_json_error"; }
    }
    const parsed = sseMetrics(responseText, item.kind);
    for (const line of responseText.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        const actualModel = event.model || event.message?.model;
        if (typeof actualModel === "string") returnedModel = actualModel;
      } catch {}
    }
    const requestTotalMs = Math.round(performance.now() - start);
    const resolution = item.route.startsWith("cc-") || item.route.startsWith("9-") ? routeResolution(since, item.route, prompt) : [];
    const expectedUpstreamModel = item.model;
    const sameModelResolved = !direct && resolution.some((entry) => entry.model === expectedUpstreamModel && entry.provider === "claude" && entry.sameClaudeAccount && entry.status === "success");
    const pass = status >= 200 && status < 300 && parsed.pass && parsed.complete && !parsed.streamError;
    const comparisonEligible = Boolean(expectedUpstreamModel && pass && returnedModel === expectedUpstreamModel && (direct || sameModelResolved));
    return { route: item.route, task: item.kind, requestedModel: model, expectedUpstreamModel, status, headerMs, firstByteMs, firstUsefulMs, totalMs: requestTotalMs, pass, streamComplete: parsed.complete, toolUseCount: parsed.toolUseCount, streamError: parsed.streamError, returnedModel, resolution, comparisonEligible, comparisonNote: direct ? "direct Claude request uses the saved account credential; compare only after a complete successful matching response" : (sameModelResolved ? "same model and Claude account resolved" : "fallback, error, or unverified leaf: exclude from direct comparison"), errorKind, ...(safeError ? { safeError } : {}) };
  } catch (error) {
    return { route: item.route, task: item.kind, requestedModel: model, expectedUpstreamModel: item.model, status, headerMs, firstByteMs, totalMs: Math.round(performance.now() - start), pass: false, comparisonEligible: false, failure: error.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

if (process.env.BENCH_PARSER_SELF_TEST === "1") {
  runParserChecks();
  console.log("benchmark SSE parser checks passed");
  process.exit(0);
}

const creds = liveCredentials();
let currentClaudeConnectionId = creds.claude.id;
let claudeCliVersion = "unknown";
let claudeCliVersionNumber = "unknown";
try {
  claudeCliVersion = execFileSync("claude", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/).slice(0, 2).join(" ");
  claudeCliVersionNumber = claudeCliVersion.match(/\d+(?:\.\d+){2}/)?.[0] || "unknown";
} catch {}
let routerVersion = "unknown";
try { const response = await fetch(`${ROUTER}/api/version`); const value = await response.json(); routerVersion = typeof value.currentVersion === "string" ? value.currentVersion : "unknown"; } catch {}
const results = [];
const selected = process.env.BENCH_CASES
  ? process.env.BENCH_CASES.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x >= 0 && x < rounds.length).map((x) => rounds[x])
  : rounds.slice(0, 2);
const pairNonces = new Map();
for (const item of selected) {
  const key = `${item.model || item.route}:${item.kind}`;
  if (!pairNonces.has(key)) pairNonces.set(key, randomUUID());
  item.nonce = pairNonces.get(key);
}
for (const item of selected) {
  results.push(await run(item, creds));
  // brief spacing avoids turning the comparison into an intentional load test
  await new Promise((resolve) => setTimeout(resolve, 750));
}
const pairs = results.filter((result) => result.route === "direct").map((directResult) => {
  const combo = matchingCombo(results, directResult);
  return { model: directResult.expectedUpstreamModel, task: directResult.task, validPair: Boolean(combo?.comparisonEligible && directResult.comparisonEligible && combo.returnedModel === directResult.returnedModel), comboModel: combo?.returnedModel || null, directModel: directResult.returnedModel || null };
});
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), phase, router: new URL(ROUTER).origin, routerVersion, claudeCliVersion, requestProfile: { thinking: thinkingMode, effort: effort || "provider_default" }, count: results.length, pairs, results }, null, 2));
