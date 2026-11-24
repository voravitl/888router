#!/usr/bin/env node
/**
 * 888router Live E2E Matrix Verification Runner
 * Tests representative active models & combos across real endpoints:
 *   1. Basic SSE stream + zero <think></think> leak in delta.content
 *   2. Multi-turn tool call continuity (Turn 1 -> Turn 2 tool_result)
 *   3. Cross-endpoint parity (/v1/messages, /v1/responses where applicable)
 *
 * Separates genuine router/translator bugs (FAIL) from upstream quota/rate-limit
 * exhaustion (WARN) and prints a concise summary table without ever printing API keys.
 *
 * Usage:
 *   node scripts/live-e2e-matrix.mjs [options]
 *   npm run test:live-e2e -- --providers anthropic,cc,codex
 */

import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const opts = {
    url: process.env.BASE_URL || "http://localhost:20129",
    key: process.env.API_KEY || "",
    providers: null,
    models: null,
    timeout: 45000,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) opts.url = argv[++i];
    else if (a === "--key" && argv[i + 1]) opts.key = argv[++i];
    else if (a === "--providers" && argv[i + 1]) opts.providers = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--model" && argv[i + 1]) (opts.models ||= []).push(argv[++i]);
    else if (a === "--timeout" && argv[i + 1]) opts.timeout = Math.max(5000, Number(argv[++i]) || 45000);
    else if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
  }
  opts.url = opts.url.replace(/\/+$/, "");
  return opts;
}

function resolveLocalApiKey(baseUrl) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)) return "";
  try {
    const out = execFileSync(
      "docker",
      [
        "exec",
        "888route",
        "node",
        "-e",
        "const D=require('better-sqlite3');const db=new D('/app/data/db/data.sqlite',{readonly:true});const r=db.prepare('SELECT key FROM apiKeys LIMIT 1').get();if(r?.key)process.stdout.write(r.key);",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.trim();
  } catch {
    return "";
  }
}

function classifyHttpError(status, bodyText) {
  const text = String(bodyText || "");
  if (status === 429 || /\b429\b|rate[_ ]?limit|quota|too many requests|credit balance|insufficient[_ ](?:quota|balance|credits)|exhausted|capacity|overloaded|try again later/i.test(text)) {
    return { level: "WARN", tag: "429/QUOTA", detail: `HTTP ${status}: ${compactErr(text)}` };
  }
  if (status === 401 || status === 403 || /invalid[_ ]api[_ ]key|unauthorized|token.*expired|reauth/i.test(text)) {
    return { level: "WARN", tag: "AUTH", detail: `HTTP ${status}: ${compactErr(text)}` };
  }
  return { level: "FAIL", tag: `HTTP ${status}`, detail: compactErr(text) };
}

function compactErr(raw) {
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message || j?.message || raw;
    return String(msg).replace(/\s+/g, " ").slice(0, 140);
  } catch {
    return String(raw || "").replace(/\s+/g, " ").slice(0, 140);
  }
}

async function readSSEFrames(res) {
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, raw, frames: [], isSSE: false };
  }
  if (!/text\/event-stream/i.test(ct) && !/^data:/m.test(raw)) {
    try {
      return { ok: true, status: res.status, raw, frames: [JSON.parse(raw)], isSSE: false };
    } catch {
      return { ok: true, status: res.status, raw, frames: [], isSSE: false };
    }
  }
  const frames = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // ignore unparseable partial/comment frames
    }
  }
  return { ok: true, status: res.status, raw, frames, isSSE: true };
}

function parseOpenAIFrames(frames, isSSE) {
  let content = "";
  let reasoning = "";
  let refusal = "";
  let finishReason = null;
  let usage = null;
  let errorMsg = null;
  const toolCallsByIdx = new Map();

  for (const f of frames) {
    if (f?.error) {
      errorMsg = f.error.message || JSON.stringify(f.error);
    }
    if (f?.usage) usage = f.usage;
    const c = f?.choices?.[0];
    if (!c) continue;
    if (c.finish_reason) finishReason = c.finish_reason;
    const msg = isSSE ? c.delta : (c.message || c.delta);
    if (!msg) continue;
    if (typeof msg.content === "string") content += msg.content;
    if (typeof msg.reasoning_content === "string") reasoning += msg.reasoning_content;
    if (typeof msg.refusal === "string") refusal += msg.refusal;
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallsByIdx.has(idx)) {
          toolCallsByIdx.set(idx, {
            id: tc.id || `call_live_${idx}`,
            type: "function",
            function: { name: tc.function?.name || "shell", arguments: "" },
          });
        }
        const entry = toolCallsByIdx.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.function.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") entry.function.arguments += tc.function.arguments;
      }
    }
  }

  return {
    content,
    reasoning,
    refusal,
    finishReason,
    usage,
    errorMsg,
    toolCalls: [...toolCallsByIdx.values()],
  };
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readSSEFrames(res);
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function probeBasicChat(opts, model) {
  const res = await postJson(
    `${opts.url}/v1/chat/completions`,
    buildAuthHeaders(opts.key),
    {
      model,
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    },
    opts.timeout
  );
  if (!res.ok) return classifyHttpError(res.status, res.raw);
  const parsed = parseOpenAIFrames(res.frames, res.isSSE);
  if (parsed.errorMsg) return classifyHttpError(res.status, parsed.errorMsg);
  if (/<\/?think>/i.test(parsed.content)) {
    return { level: "FAIL", tag: "THINK_LEAK", detail: `delta.content leaked think tag: ${JSON.stringify(parsed.content.slice(0, 80))}` };
  }
  if (parsed.refusal || parsed.finishReason === "content_filter") {
    return { level: "FAIL", tag: "REFUSAL", detail: `Unexpected refusal on benign prompt: ${parsed.refusal.slice(0, 100)}` };
  }
  if (!parsed.content.trim() && parsed.toolCalls.length === 0) {
    return { level: "FAIL", tag: "EMPTY", detail: `HTTP 200 empty content (finish=${parsed.finishReason}, reasoning=${parsed.reasoning.length}c)` };
  }
  return { level: "PASS", tag: "OK", detail: `len=${parsed.content.length}, finish=${parsed.finishReason}` };
}

const SHELL_TOOL = {
  type: "function",
  function: {
    name: "shell",
    description: "Execute a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
};

async function probeMultiTurnTools(opts, model) {
  const t1 = await postJson(
    `${opts.url}/v1/chat/completions`,
    buildAuthHeaders(opts.key),
    {
      model,
      stream: true,
      max_tokens: 1024,
      tools: [SHELL_TOOL],
      messages: [{ role: "user", content: "Use the shell tool to run `echo ok`." }],
    },
    opts.timeout
  );
  if (!t1.ok) return classifyHttpError(t1.status, t1.raw);
  const p1 = parseOpenAIFrames(t1.frames, t1.isSSE);
  if (p1.errorMsg) return classifyHttpError(t1.status, p1.errorMsg);
  if (/<\/?think>/i.test(p1.content)) {
    return { level: "FAIL", tag: "T1_THINK_LEAK", detail: `Turn 1 delta.content leaked think tag` };
  }

  const assistantToolCalls = p1.toolCalls.length > 0
    ? p1.toolCalls.map((tc) => ({
        ...tc,
        function: {
          name: tc.function.name || "shell",
          arguments: tc.function.arguments && tc.function.arguments.trim() ? tc.function.arguments : '{"command":"echo ok"}',
        },
      }))
    : [{
        id: "call_e2e_matrix_1",
        type: "function",
        function: { name: "shell", arguments: '{"command":"echo ok"}' },
      }];

  const assistantMsg = {
    role: "assistant",
    content: p1.toolCalls.length > 0 && p1.content ? p1.content : null,
    tool_calls: assistantToolCalls,
  };

  const t2 = await postJson(
    `${opts.url}/v1/chat/completions`,
    buildAuthHeaders(opts.key),
    {
      model,
      stream: true,
      max_tokens: 1024,
      tools: [SHELL_TOOL],
      messages: [
        { role: "user", content: "Use the shell tool to run `echo ok`." },
        assistantMsg,
        { role: "tool", tool_call_id: assistantToolCalls[0].id, content: "ok\n" },
      ],
    },
    opts.timeout
  );
  if (!t2.ok) return classifyHttpError(t2.status, t2.raw);
  const p2 = parseOpenAIFrames(t2.frames, t2.isSSE);
  if (p2.errorMsg) return classifyHttpError(t2.status, p2.errorMsg);
  if (/<\/?think>/i.test(p2.content)) {
    return { level: "FAIL", tag: "T2_THINK_LEAK", detail: `Turn 2 delta.content leaked think tag` };
  }
  if (p2.refusal || p2.finishReason === "content_filter") {
    return { level: "FAIL", tag: "T2_REFUSAL", detail: `Turn 2 refusal: ${p2.refusal.slice(0, 100)}` };
  }
  if (!p2.content.trim() && p2.toolCalls.length === 0) {
    return { level: "FAIL", tag: "T2_EMPTY", detail: `Turn 2 HTTP 200 empty content (finish=${p2.finishReason})` };
  }
  return {
    level: "PASS",
    tag: p1.toolCalls.length > 0 ? "LIVE_T1+T2" : "SYNTH_T2",
    detail: `len=${p2.content.length}, finish=${p2.finishReason}`,
  };
}

async function probeClaudeMessages(opts, model) {
  const res = await postJson(
    `${opts.url}/v1/messages`,
    {
      ...buildAuthHeaders(opts.key),
      "anthropic-version": "2023-06-01",
    },
    {
      model,
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    },
    opts.timeout
  );
  if (!res.ok) return classifyHttpError(res.status, res.raw);

  let text = "";
  let stopReason = null;
  let errorMsg = null;
  for (const f of res.frames) {
    if (f?.type === "error" || f?.error) errorMsg = f?.error?.message || JSON.stringify(f?.error || f);
    if (f?.type === "content_block_delta" && f?.delta?.type === "text_delta" && f.delta.text) text += f.delta.text;
    if (f?.type === "message_delta" && f?.delta?.stop_reason) stopReason = f.delta.stop_reason;
    if (!res.isSSE && Array.isArray(f?.content)) {
      for (const b of f.content) if (b?.type === "text" && b.text) text += b.text;
      if (f.stop_reason) stopReason = f.stop_reason;
    }
  }
  if (errorMsg) return classifyHttpError(res.status, errorMsg);
  if (stopReason === "refusal") return { level: "FAIL", tag: "MSG_REFUSAL", detail: `stop_reason=refusal` };
  if (!text.trim()) return { level: "FAIL", tag: "MSG_EMPTY", detail: `HTTP 200 empty text (stop=${stopReason})` };
  return { level: "PASS", tag: "OK", detail: `len=${text.length}, stop=${stopReason}` };
}

async function probeResponsesApi(opts, model) {
  const res = await postJson(
    `${opts.url}/v1/responses`,
    buildAuthHeaders(opts.key),
    {
      model,
      stream: true,
      max_output_tokens: 1024,
      input: "Reply with just: OK",
    },
    opts.timeout
  );
  if (!res.ok) return classifyHttpError(res.status, res.raw);

  let text = "";
  let status = null;
  let errorMsg = null;
  for (const f of res.frames) {
    if (f?.type === "error" || f?.error) errorMsg = f?.error?.message || JSON.stringify(f?.error || f);
    if (f?.type === "response.output_text.delta" && typeof f.delta === "string") text += f.delta;
    if (f?.type === "response.completed") status = f.response?.status || "completed";
    if (!res.isSSE && Array.isArray(f?.output)) {
      for (const item of f.output) {
        for (const c of item?.content || []) if (c?.type === "output_text" && c.text) text += c.text;
      }
      status = f.status || "completed";
    }
  }
  if (errorMsg) return classifyHttpError(res.status, errorMsg);
  if (!text.trim()) return { level: "FAIL", tag: "RESP_EMPTY", detail: `HTTP 200 empty text (status=${status})` };
  return { level: "PASS", tag: "OK", detail: `len=${text.length}, status=${status}` };
}

const TARGET_SPECS = [
  { key: "anthropic", prefix: "anthropic/", preferred: ["anthropic/claude-fable-5-2", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"], extra: "messages" },
  { key: "cc-sonnet", prefix: "cc/", preferred: ["cc/claude-sonnet-5-5", "cc/claude-haiku-5-5"], extra: "messages" },
  { key: "cc-fable", prefix: "cc/", preferred: ["cc/claude-fable-5-2"], extra: null },
  { key: "codex", prefix: "cx/", preferred: ["cx/gpt-5.6-luna", "cx/gpt-6-luna", "cx/gpt-6-astra", "cx/gpt-6.1-sol"], extra: "responses" },
  { key: "ag-gemini", prefix: "ag/", preferred: ["ag/gemini-4-neon-medium", "ag/gemini-4-neon-high", "ag/gemini-4-hydrogen-medium", "ag/gemini-3.8-flash-medium", "ag/gemini-2.5-flash"], excludeRe: /image/i, extra: null },
  { key: "kiro", prefix: "kr/", preferred: ["kr/claude-sonnet-5-5", "kr/claude-haiku-5-5", "kr/auto"], extra: null },
  { key: "ollama", prefix: "ollama/", preferred: ["ollama/deepseek-v4.1-flash", "ollama/kimi-k2.7-code", "ollama/glm-5.3-flash"], extra: null },
  { key: "opencode", prefix: "oc/", preferred: ["oc/deepseek-v4.1-flash-free", "oc/mimo-v2.6-flash-free", "oc/big-pickle"], extra: null },
  { key: "opencode-go", prefix: "ocg/", preferred: ["ocg/deepseek-v4.1-flash", "ocg/glm-5.3-flash", "ocg/gpt-6-luna"], extra: null },
  { key: "cloudflare-ai", prefix: "cf/", preferred: ["cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cf/@cf/meta/llama-3.1-8b-instruct-fp8-fast"], extra: null },
  { key: "nvidia", prefix: "nvidia/", preferred: ["nvidia/deepseek-ai/deepseek-v4-flash", "nvidia/z-ai/glm-5.3-flash", "nvidia/minimaxai/minimax-m3.1-flash"], extra: null },
  { key: "openrouter", prefix: "openrouter/", preferred: ["openrouter/nvidia/nemotron-3.5-super-vl:free", "openrouter/recursive/flint-v1.0:free"], excludeRe: /:batch$/i, extra: null },
  { key: "nous", prefix: "nous/", preferred: ["nous/hermes-4-405b", "nous/google/gemini-4-neon"], extra: null },
  { key: "combo-fusion", exactList: ["9-fusion"], extra: null },
  { key: "combo-free", exactList: ["9-free"], extra: null },
  { key: "combo-ccfable", exactList: ["cc-fable"], extra: null },
];

function selectTargets(availableIds, opts) {
  const idSet = new Set(availableIds);
  if (opts.models?.length) {
    return opts.models.map((model) => ({ key: model, model, extra: model.startsWith("anthropic/") || model.startsWith("cc/") ? "messages" : model.startsWith("cx/") ? "responses" : null }));
  }
  const chosen = [];
  for (const spec of TARGET_SPECS) {
    if (opts.providers && !opts.providers.some((p) => spec.key === p || spec.key.startsWith(p) || (spec.prefix && spec.prefix.replace(/\/$/, "") === p))) {
      continue;
    }
    let model = null;
    if (spec.exactList) {
      model = spec.exactList.find((id) => idSet.has(id)) || null;
    } else {
      model = spec.preferred.find((id) => idSet.has(id)) || null;
      if (!model) {
        model = availableIds.find((id) => id.startsWith(spec.prefix) && (!spec.excludeRe || !spec.excludeRe.test(id))) || null;
      }
    }
    if (model) {
      chosen.push({ key: spec.key, model, extra: spec.extra });
    }
  }
  return chosen;
}

function overallStatus(checks) {
  const values = Object.values(checks).filter(Boolean);
  if (values.some((c) => c.level === "FAIL")) return "FAIL";
  if (values.some((c) => c.level === "WARN")) return "WARN";
  return "PASS";
}

function fmtCell(check) {
  if (!check) return "-";
  return `${check.level}:${check.tag}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.key) {
    opts.key = resolveLocalApiKey(opts.url);
  }

  const modelsRes = await fetch(`${opts.url}/v1/models`, {
    headers: buildAuthHeaders(opts.key),
    signal: AbortSignal.timeout(opts.timeout),
  });
  if (!modelsRes.ok) {
    console.error(`Failed to list /v1/models from ${opts.url}: HTTP ${modelsRes.status}`);
    process.exit(2);
  }
  const modelsJson = await modelsRes.json();
  const availableIds = (modelsJson.data || []).map((m) => m.id).filter(Boolean);
  const targets = selectTargets(availableIds, opts);

  if (targets.length === 0) {
    console.error("No matching active targets found in /v1/models");
    process.exit(2);
  }

  const results = [];
  for (const t of targets) {
    const start = Date.now();
    const checks = {};
    try {
      checks.stream = await probeBasicChat(opts, t.model);
    } catch (e) {
      checks.stream = { level: "FAIL", tag: "EXC", detail: e.message };
    }
    try {
      checks.tools = await probeMultiTurnTools(opts, t.model);
    } catch (e) {
      checks.tools = { level: "FAIL", tag: "EXC", detail: e.message };
    }
    if (t.extra === "messages") {
      try {
        checks.parity = await probeClaudeMessages(opts, t.model);
      } catch (e) {
        checks.parity = { level: "FAIL", tag: "EXC", detail: e.message };
      }
    } else if (t.extra === "responses") {
      try {
        checks.parity = await probeResponsesApi(opts, t.model);
      } catch (e) {
        checks.parity = { level: "FAIL", tag: "EXC", detail: e.message };
      }
    }

    const status = overallStatus(checks);
    results.push({
      key: t.key,
      model: t.model,
      status,
      durationMs: Date.now() - start,
      checks,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ url: opts.url, totalModels: availableIds.length, results }, null, 2));
  } else {
    console.log(`\nLive E2E Matrix (${opts.url}) — ${targets.length} targets from ${availableIds.length} active models\n`);
    console.log(
      "Target".padEnd(16) +
      "Model".padEnd(40) +
      "Status".padEnd(8) +
      "Stream".padEnd(18) +
      "Turn1->2".padEnd(18) +
      "Parity".padEnd(16) +
      "ms"
    );
    console.log("-".repeat(122));
    for (const r of results) {
      console.log(
        r.key.padEnd(16) +
        r.model.slice(0, 38).padEnd(40) +
        r.status.padEnd(8) +
        fmtCell(r.checks.stream).padEnd(18) +
        fmtCell(r.checks.tools).padEnd(18) +
        fmtCell(r.checks.parity).padEnd(16) +
        String(r.durationMs)
      );
    }

    const nonPass = results.filter((r) => r.status !== "PASS");
    if (nonPass.length > 0) {
      console.log("\nDetails for FAIL / WARN:");
      for (const r of nonPass) {
        for (const [k, c] of Object.entries(r.checks)) {
          if (c && c.level !== "PASS") {
            console.log(`  [${c.level}] ${r.model} (${k}/${c.tag}): ${c.detail}`);
          }
        }
      }
    }
    const failCnt = results.filter((r) => r.status === "FAIL").length;
    const warnCnt = results.filter((r) => r.status === "WARN").length;
    const passCnt = results.filter((r) => r.status === "PASS").length;
    console.log(`\nSummary: PASS=${passCnt}, WARN(429/AUTH)=${warnCnt}, FAIL(BUG)=${failCnt}\n`);
  }

  const hasFail = results.some((r) => r.status === "FAIL");
  const hasWarn = results.some((r) => r.status === "WARN");
  if (hasFail || (opts.strict && hasWarn)) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(2);
});
