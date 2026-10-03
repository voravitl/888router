#!/usr/bin/env node
/**
 * Offline payload/parser checks by default. Live requests require explicit opt-in.
 * Prints summary JSON only: no credentials, headers, prompts, or response bodies.
 * Estimated token counts and mock replies do not prove provider context support.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { estimateRequestTokens } from "../open-sse/services/requestContext.js";

const FORMATS = ["anthropic", "openai-chat", "responses", "gemini"];
const SIZES = [50_000, 200_000, 500_000];
const schema = { type: "object", properties: { start: { type: "string" }, middle: { type: "string" }, end: { type: "string" } }, required: ["start", "middle", "end"], additionalProperties: false };
const toolName = "capture_context";
const filler = "Reference entry: retain the full history. ภาษาไทย 中文 🌏 café.\n";

function payload(format, kind, target, model) {
  const nonce = randomUUID();
  const expected = Object.fromEntries(["start", "middle", "end"].map((position) => [position, `${position}_${nonce}`]));
  const instructions = `Find the three CURRENT_CONTEXT markers in the document; previous tool results are unrelated. ${kind === "tool" ? `Call ${toolName} once with their values.` : "Return only a JSON object with keys start, middle, end containing their values."}`;
  const fillerTokens = estimateRequestTokens({ prompt: filler.repeat(100) }) / 100;
  const blocks = Math.ceil(target / fillerTokens);
  const document = `CURRENT_CONTEXT_START=${expected.start}\n${filler.repeat(Math.floor(blocks / 2))}CURRENT_CONTEXT_MIDDLE=${expected.middle}\n${filler.repeat(Math.ceil(blocks / 2))}CURRENT_CONTEXT_END=${expected.end}\n${instructions}`;
  const previous = { start: "previous_start", middle: "previous_middle", end: "previous_end" };
  let body;
  if (format === "anthropic") {
    body = { model, max_tokens: 256, stream: false, messages: [
      { role: "user", content: "Capture the previous markers." },
      { role: "assistant", content: [{ type: "tool_use", id: "previous_call", name: toolName, input: previous }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "previous_call", content: "Previous markers captured." }, { type: "text", text: document }] },
    ], tools: [{ name: toolName, description: "Record the three current context markers.", input_schema: schema }] };
  } else if (format === "openai-chat") {
    body = { model, max_tokens: 256, stream: false, messages: [
      { role: "user", content: "Capture the previous markers." },
      { role: "assistant", content: null, tool_calls: [{ id: "previous_call", type: "function", function: { name: toolName, arguments: JSON.stringify(previous) } }] },
      { role: "tool", tool_call_id: "previous_call", content: "Previous markers captured." },
      { role: "user", content: document },
    ], tools: [{ type: "function", function: { name: toolName, description: "Record the three current context markers.", parameters: schema } }] };
  } else if (format === "responses") {
    body = { model, max_output_tokens: 256, stream: false, input: [
      { role: "user", content: "Capture the previous markers." },
      { type: "function_call", call_id: "previous_call", name: toolName, arguments: JSON.stringify(previous) },
      { type: "function_call_output", call_id: "previous_call", output: "Previous markers captured." },
      { role: "user", content: [{ type: "input_text", text: document }] },
    ], tools: [{ type: "function", name: toolName, description: "Record the three current context markers.", parameters: schema }] };
  } else if (format === "gemini") {
    body = { contents: [
      { role: "user", parts: [{ text: "Capture the previous markers." }] },
      { role: "model", parts: [{ functionCall: { name: toolName, args: previous } }] },
      { role: "user", parts: [{ functionResponse: { name: toolName, response: { result: "Previous markers captured." } } }, { text: document }] },
    ], tools: [{ functionDeclarations: [{ name: toolName, description: "Record the three current context markers.", parameters: schema }] }], generationConfig: { maxOutputTokens: 256 } };
  } else throw new Error("unsupported_format");
  return { body, expected, nonce, document, format, kind, target };
}

function parseResponse(format, value, kind, expected) {
  let text = "";
  let calls = [];
  let complete = false;
  let inputTokens = null;
  let outputTokens = null;
  let cachedInputTokens = null;
  let cacheCreationInputTokens = null;
  if (format === "anthropic") {
    text = (value.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("");
    calls = (value.content || []).filter((block) => block.type === "tool_use").map((block) => ({ name: block.name, args: block.input }));
    complete = ["end_turn", "tool_use"].includes(value.stop_reason);
    inputTokens = value.usage?.input_tokens ?? null;
    cachedInputTokens = value.usage?.cache_read_input_tokens ?? null;
    cacheCreationInputTokens = value.usage?.cache_creation_input_tokens ?? null;
    outputTokens = value.usage?.output_tokens ?? null;
  } else if (format === "openai-chat") {
    const choice = value.choices?.[0];
    text = choice?.message?.content || "";
    calls = (choice?.message?.tool_calls || []).map((call) => ({ name: call.function?.name, args: call.function?.arguments }));
    complete = ["stop", "tool_calls"].includes(choice?.finish_reason);
    inputTokens = value.usage?.prompt_tokens ?? null;
    cachedInputTokens = value.usage?.prompt_tokens_details?.cached_tokens ?? null;
    outputTokens = value.usage?.completion_tokens ?? null;
  } else if (format === "responses") {
    text = (value.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text || "").join("");
    calls = (value.output || []).filter((item) => item.type === "function_call").map((call) => ({ name: call.name, args: call.arguments }));
    complete = value.status === "completed";
    inputTokens = value.usage?.input_tokens ?? null;
    cachedInputTokens = value.usage?.input_tokens_details?.cached_tokens ?? null;
    outputTokens = value.usage?.output_tokens ?? null;
  } else {
    const candidate = value.candidates?.[0];
    text = (candidate?.content?.parts || []).map((part) => part.text || "").join("");
    calls = (candidate?.content?.parts || []).filter((part) => part.functionCall).map((part) => ({ name: part.functionCall.name, args: part.functionCall.args }));
    complete = candidate?.finishReason === "STOP";
    inputTokens = value.usageMetadata?.promptTokenCount ?? null;
    cachedInputTokens = value.usageMetadata?.cachedContentTokenCount ?? null;
    outputTokens = value.usageMetadata?.candidatesTokenCount ?? null;
  }
  let actual;
  try {
    actual = kind === "text" ? JSON.parse(text.trim()) : typeof calls[0]?.args === "string" ? JSON.parse(calls[0].args) : calls[0]?.args;
  } catch { actual = null; }
  const markersMatch = actual && Object.keys(actual).length === 3 && Object.entries(expected).every(([key, marker]) => actual[key] === marker);
  const taskPassed = Boolean(markersMatch && (kind === "text" ? calls.length === 0 : calls.length === 1 && calls[0].name === toolName));
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  inputTokens = count(inputTokens);
  cachedInputTokens = count(cachedInputTokens);
  cacheCreationInputTokens = count(cacheCreationInputTokens);
  outputTokens = count(outputTokens);
  const totalInputTokens = inputTokens === null ? null : format === "anthropic" ? inputTokens + (cachedInputTokens || 0) + (cacheCreationInputTokens || 0) : inputTokens;
  return { pass: taskPassed && complete && !value.error, taskPassed, complete, inputTokens, cachedInputTokens, cacheCreationInputTokens, totalInputTokens, outputTokens, returnedModel: value.model || value.modelVersion || null };
}

function contextMeasurement(parsed, target) {
  const actualTotalInputTokens = parsed.usageProvenance === "provider_response_telemetry" && !parsed.estimatedUsage
    ? parsed.verifiedTotalInputTokens ?? null : null;
  const contextTargetMet = actualTotalInputTokens === null ? null : actualTotalInputTokens >= target;
  return { actualTotalInputTokens, contextTargetMet, contextVerification: contextTargetMet === null ? "not_measured" : contextTargetMet ? "provider_reported_target_met" : "below_requested_target" };
}

function verifiedProviderUsage(routing) {
  const selected = routing.records?.find((record) => ["success", "200", 200].includes(record.status));
  const usage = selected?.upstreamUsage;
  const metadata = selected?.upstreamUsageMetadata;
  if ((!usage && !metadata) || usage?.estimated || metadata?.estimated) return {};
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  let total = count(metadata?.promptTokenCount ?? usage?.prompt_tokens ?? usage?.input_tokens);
  // Claude cache tokens are exclusive of input_tokens; Responses/OpenAI totals
  // already include cache hits. Read raw provider fields, before gateway padding.
  if (total !== null && usage?.input_tokens !== undefined &&
    (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined)) {
    const read = count(usage.cache_read_input_tokens ?? 0);
    const created = count(usage.cache_creation_input_tokens ?? 0);
    total = read === null || created === null ? null : total + read + created;
  }
  return total === null ? {} : { usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: total };
}

function selectedRoute(parsed, routing, requestedModel) {
  const selected = routing.records?.find((record) => ["success", "200", 200].includes(record.status));
  const returnedModelMatchesTrace = selected?.model && parsed.returnedModel ? selected.model === parsed.returnedModel : null;
  return {
    actualSelectedLeaf: { provider: selected?.provider || null, model: selected?.model || parsed.returnedModel, connectionId: selected?.connectionId || null },
    routeIdentityVerification: returnedModelMatchesTrace === false ? "response_telemetry_mismatch" : selected ? "telemetry_available" : parsed.returnedModel ? "response_only" : "not_measured",
    returnedModelMatchesTrace,
    requestedModelMatchesReturned: parsed.returnedModel ? requestedModel === parsed.returnedModel : null,
    directProviderComparison: "not_performed",
  };
}

function fixtureUsage(format, input, cached = 0, created = 0) {
  if (format === "anthropic") return { usage: { input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: created } };
  if (format === "openai-chat") return { usage: { prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached } } };
  if (format === "responses") return { usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached } } };
  return { usageMetadata: { promptTokenCount: input, cachedContentTokenCount: cached } };
}

function mockReply(format, kind, expected) {
  const text = JSON.stringify(expected);
  if (format === "anthropic") return { content: kind === "text" ? [{ type: "text", text }] : [{ type: "tool_use", name: toolName, input: expected }], stop_reason: kind === "text" ? "end_turn" : "tool_use" };
  if (format === "openai-chat") return { choices: [{ message: kind === "text" ? { content: text } : { tool_calls: [{ function: { name: toolName, arguments: text } }] }, finish_reason: kind === "text" ? "stop" : "tool_calls" }] };
  if (format === "responses") return { status: "completed", output: kind === "text" ? [{ type: "message", content: [{ type: "output_text", text }] }] : [{ type: "function_call", name: toolName, arguments: text }] };
  return { candidates: [{ finishReason: "STOP", content: { parts: kind === "text" ? [{ text }] : [{ functionCall: { name: toolName, args: expected } }] } }] };
}

function validateOffline(item) {
  const encoded = JSON.stringify(item.body);
  const decoded = JSON.parse(encoded);
  assert.deepEqual(decoded, item.body);
  for (const marker of Object.values(item.expected)) assert.equal(encoded.split(marker).length - 1, 1);
  assert.ok(encoded.includes("ภาษาไทย 中文 🌏 café"));
  assert.ok(encoded.includes(toolName));
  assert.ok(encoded.includes("Previous markers captured."));
  assert.ok(item.document.indexOf(item.expected.start) < item.document.indexOf(item.expected.middle));
  assert.ok(item.document.indexOf(item.expected.middle) < item.document.indexOf(item.expected.end));
  assert.ok(estimateRequestTokens(item.body) >= item.target);
  assert.ok(estimateRequestTokens(item.body) < item.target + Math.max(1_000, item.target * 0.05));
  assert.equal(parseResponse(item.format, mockReply(item.format, item.kind, item.expected), item.kind, item.expected).pass, true);
  // Correct markers alone never certify the actual input size or selected model.
  const validReply = mockReply(item.format, item.kind, item.expected);
  const missingUsage = parseResponse(item.format, validReply, item.kind, item.expected);
  assert.deepEqual(contextMeasurement(missingUsage, item.target), { actualTotalInputTokens: null, contextTargetMet: null, contextVerification: "not_measured" });
  assert.equal(contextMeasurement({ usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: 513_352 }, 500_000).contextTargetMet, true);
  assert.equal(contextMeasurement({ usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: 513_352 }, 800_000).contextTargetMet, false);
  const tinyUsage = parseResponse(item.format, { ...validReply, ...fixtureUsage(item.format, 5), model: "different-selected-model" }, item.kind, item.expected);
  assert.equal(tinyUsage.pass, true);
  assert.equal(contextMeasurement({ ...tinyUsage, usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: 5 }, item.target).contextTargetMet, false);
  assert.equal(contextMeasurement({ ...tinyUsage, usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: 5 }, item.target).contextVerification, "below_requested_target");
  const route = selectedRoute(tinyUsage, { available: false }, "requested-model");
  assert.equal(route.requestedModelMatchesReturned, false);
  assert.equal(route.actualSelectedLeaf.model, "different-selected-model");
  assert.equal(route.directProviderComparison, "not_performed");
  const mismatch = selectedRoute(tinyUsage, { records: [{ status: "success", model: "other-trace-model" }] }, "requested-model");
  assert.equal(mismatch.returnedModelMatchesTrace, false);
  const cachedReply = parseResponse(item.format, { ...validReply, ...fixtureUsage(item.format, item.format === "anthropic" ? 5 : item.target, item.target - 10, 5) }, item.kind, item.expected);
  assert.equal(cachedReply.totalInputTokens, item.target);
  assert.equal(contextMeasurement({ ...cachedReply, usageProvenance: "provider_response_telemetry", verifiedTotalInputTokens: cachedReply.totalInputTokens }, item.target).contextTargetMet, true);
  assert.equal(contextMeasurement({ ...cachedReply, totalInputTokens: item.target + 2000 }, item.target).contextVerification, "not_measured");
  assert.deepEqual(verifiedProviderUsage({ records: [{ status: "success", upstreamUsage: { prompt_tokens: item.target, estimated: true } }] }), {});
  const padded = { ...cachedReply, ...verifiedProviderUsage({ records: [{ status: "success", upstreamUsage: { prompt_tokens: item.target - 1500 } }] }) };
  assert.equal(contextMeasurement(padded, item.target).contextTargetMet, false);
  const invalidUsage = parseResponse(item.format, { ...validReply, ...fixtureUsage(item.format, "500000") }, item.kind, item.expected);
  assert.equal(contextMeasurement(invalidUsage, item.target).contextVerification, "not_measured");
  const wrong = { ...item.expected, middle: "missing_middle" };
  assert.equal(parseResponse(item.format, mockReply(item.format, item.kind, wrong), item.kind, item.expected).pass, false);
  const incomplete = mockReply(item.format, item.kind, item.expected);
  if (item.format === "anthropic") incomplete.stop_reason = "max_tokens";
  else if (item.format === "openai-chat") incomplete.choices[0].finish_reason = "length";
  else if (item.format === "responses") incomplete.status = "incomplete";
  else incomplete.candidates[0].finishReason = "MAX_TOKENS";
  assert.equal(parseResponse(item.format, incomplete, item.kind, item.expected).pass, false);
  const failed = { ...mockReply(item.format, item.kind, item.expected), error: { type: "upstream_error" } };
  assert.equal(parseResponse(item.format, failed, item.kind, item.expected).pass, false);
  if (item.kind === "text") {
    const unsolicitedTool = mockReply(item.format, "tool", item.expected);
    if (item.format === "anthropic") unsolicitedTool.content.unshift({ type: "text", text: JSON.stringify(item.expected) });
    else if (item.format === "openai-chat") unsolicitedTool.choices[0].message.content = JSON.stringify(item.expected);
    else if (item.format === "responses") unsolicitedTool.output.unshift({ type: "message", content: [{ type: "output_text", text: JSON.stringify(item.expected) }] });
    else unsolicitedTool.candidates[0].content.parts.unshift({ text: JSON.stringify(item.expected) });
    assert.equal(parseResponse(item.format, unsolicitedTool, item.kind, item.expected).pass, false);
  }
  if (item.kind === "tool") {
    const duplicate = mockReply(item.format, item.kind, item.expected);
    if (item.format === "anthropic") duplicate.content.push(duplicate.content[0]);
    else if (item.format === "openai-chat") duplicate.choices[0].message.tool_calls.push(duplicate.choices[0].message.tool_calls[0]);
    else if (item.format === "responses") duplicate.output.push(duplicate.output[0]);
    else duplicate.candidates[0].content.parts.push(duplicate.candidates[0].content.parts[0]);
    assert.equal(parseResponse(item.format, duplicate, item.kind, item.expected).pass, false);
  }
  return { format: item.format, task: item.kind, targetEstimatedTokens: item.target, estimatedInputTokens: estimateRequestTokens(item.body), characterEstimateTokens: Math.ceil(encoded.length / 4), bytes: Buffer.byteLength(encoded), roundTripAndParserPass: true };
}

function sqliteRead(source, args = []) {
  return JSON.parse(execFileSync("docker", ["compose", "exec", "-T", "888route", "node", "-e", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 64 * 1024 }));
}

function routerKey() {
  if (process.env.LONG_CONTEXT_API_KEY) return process.env.LONG_CONTEXT_API_KEY;
  if (process.env.LONG_CONTEXT_SQLITE !== "true") throw new Error("live_api_key_required");
  const result = sqliteRead("const D=require('better-sqlite3');const d=new D('/app/data/db/data.sqlite',{readonly:true,fileMustExist:true});const r=d.prepare('SELECT key FROM apiKeys WHERE isActive=1 ORDER BY createdAt ASC LIMIT 1').get();process.stdout.write(JSON.stringify({key:r?.key}));d.close();");
  if (!result.key) throw new Error("live_api_key_required");
  return result.key;
}

function routingTrace(timestamp, nonce) {
  if (process.env.LONG_CONTEXT_SQLITE !== "true") return { available: false };
  try {
    const records = sqliteRead("const D=require('better-sqlite3');const d=new D('/app/data/db/data.sqlite',{readonly:true,fileMustExist:true});const r=d.prepare(`SELECT timestamp,provider,model,connectionId,status,json_extract(data,'$.providerResponse.usage') AS upstreamUsage,json_extract(data,'$.providerResponse.usageMetadata') AS upstreamUsageMetadata FROM requestDetails WHERE timestamp>=? AND instr(data,?)>0 ORDER BY timestamp DESC LIMIT 10`).all(process.argv[1],process.argv[2]);process.stdout.write(JSON.stringify(r));d.close();", [timestamp, nonce]);
    return { available: records.length > 0, records: records.map((record) => ({ ...record,
      upstreamUsage: typeof record.upstreamUsage === "string" ? JSON.parse(record.upstreamUsage) : record.upstreamUsage,
      upstreamUsageMetadata: typeof record.upstreamUsageMetadata === "string" ? JSON.parse(record.upstreamUsageMetadata) : record.upstreamUsageMetadata,
    })) };
  } catch { return { available: false }; }
}

function endpoint(base, format, model) {
  const suffix = format === "anthropic" ? "/v1/messages" : format === "responses" ? "/v1/responses" : format === "openai-chat" ? "/v1/chat/completions" : `/v1beta/models/${model.split("/").map(encodeURIComponent).join("/")}:generateContent`;
  return `${base.replace(/\/$/, "")}${suffix}`;
}

async function runLive(item, base, model, key, timeoutMs) {
  const started = performance.now();
  const timestamp = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  const summary = { format: item.format, task: item.kind, requestedModel: model, targetEstimatedTokens: item.target, targetMeasuredTokens: item.measurementTarget, estimatedInputTokens: estimateRequestTokens(item.body), characterEstimateTokens: Math.ceil(JSON.stringify(item.body).length / 4) };
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    if (item.format === "anthropic") headers["anthropic-version"] = "2023-06-01";
    const response = await fetch(endpoint(base, item.format, model), { method: "POST", headers, body: JSON.stringify(item.body), signal: controller.signal });
    status = response.status;
    const headersMs = Math.round(performance.now() - started);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty_response");
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("response_limit_exceeded"); }
      chunks.push(Buffer.from(value));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = parseResponse(item.format, value, item.kind, item.expected);
    const routing = routingTrace(timestamp, item.nonce);
    const measurement = contextMeasurement({ ...parsed, ...verifiedProviderUsage(routing) }, item.measurementTarget);
    const route = selectedRoute(parsed, routing, model);
    const pass = response.ok && parsed.pass;
    return { ...summary, ...parsed, pass, ...measurement, ...route, usageProvenance: measurement.actualTotalInputTokens === null ? "not_verified" : "provider_response_telemetry", measuredContextTaskPass: pass && measurement.contextTargetMet === true && route.returnedModelMatchesTrace !== false, status, headersMs, totalMs: Math.round(performance.now() - started), routing };
  } catch (error) {
    const category = controller.signal.aborted ? "timeout" : ["response_limit_exceeded", "empty_response"].includes(error.message) ? error.message : "request_or_parse_error";
    return { ...summary, pass: false, measuredContextTaskPass: false, actualTotalInputTokens: null, contextTargetMet: null, contextVerification: "not_measured", directProviderComparison: "not_performed", status, totalMs: Math.round(performance.now() - started), errorCategory: category, routing: routingTrace(timestamp, item.nonce) };
  } finally { clearTimeout(timer); }
}

async function main() {
  const live = process.env.LONG_CONTEXT_LIVE === "true";
  const formats = process.env.LONG_CONTEXT_FORMATS?.split(",") || (live ? ["openai-chat"] : FORMATS);
  const sizes = process.env.LONG_CONTEXT_SIZES?.split(",").map(Number) || (live ? [50_000] : SIZES);
  assert.ok(formats.length > 0 && formats.every((format) => FORMATS.includes(format)), "invalid_formats");
  assert.ok(sizes.length > 0 && sizes.every((size) => Number.isInteger(size) && size >= 1_000 && size <= 1_000_000), "invalid_sizes");
  const minimumActual = process.env.LONG_CONTEXT_MIN_ACTUAL_INPUT_TOKENS === undefined ? null : Number(process.env.LONG_CONTEXT_MIN_ACTUAL_INPUT_TOKENS);
  assert.ok(minimumActual === null || (Number.isInteger(minimumActual) && minimumActual >= 1_000 && minimumActual <= 1_000_000), "invalid_actual_input_target");
  const model = process.env.LONG_CONTEXT_MODEL || "offline-model";
  if (live && !process.env.LONG_CONTEXT_MODEL) throw new Error("live_model_required");
  const timeoutMs = Number(process.env.LONG_CONTEXT_TIMEOUT_MS || 180_000);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000, "invalid_timeout");
  const key = live ? routerKey() : null;
  const results = [];
  for (const format of formats) {
    for (const size of sizes) {
      for (const kind of ["text", "tool"]) {
        const item = payload(format, kind, size, model);
        item.measurementTarget = minimumActual ?? size;
        const offline = validateOffline(item);
        results.push(live ? await runLive(item, process.env.LONG_CONTEXT_BASE_URL || "http://localhost:20129", model, key, timeoutMs) : offline);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: live ? "live" : "offline", estimateBasis: "gateway_unicode_aware_routing_estimate_not_provider_tokenization", limitations: live ? "pass means HTTP/completion/marker task success only; measuredContextTaskPass also requires provider-reported input at target. Neither proves full-history retention, performance parity, or universal model capacity." : "Generator/parser checks only: no gateway handler, provider, network, or paid request was exercised.", results }, null, 2)}\n`);
  if (live && results.some((result) => !result.pass)) process.exitCode = 1;
}

main().catch(() => { process.stdout.write(`${JSON.stringify({ errorCategory: "benchmark_configuration_or_selftest_failed", pass: false })}\n`); process.exitCode = 1; });
