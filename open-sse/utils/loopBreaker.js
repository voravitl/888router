import crypto from "node:crypto";
import { extractClientSessionId } from "./sessionManager.js";

export const IDENTICAL_TOOL_STREAK = 5;
export const IDENTICAL_ERROR_STREAK = 4;
export const SESSION_BURST_THRESHOLD = 6;
const BURST_WINDOW_MS = 5 * 60 * 1000;
const MAX_BURST_ENTRIES = 1000;

if (!globalThis._loopBreakerStore) {
  globalThis._loopBreakerStore = new Map();
}
const burstStore = globalThis._loopBreakerStore;

if (!globalThis._loopBreakerCleanupTimer) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of burstStore) {
      if (now - entry.lastSeenAt > BURST_WINDOW_MS) {
        burstStore.delete(k);
      }
    }
  }, BURST_WINDOW_MS);
  timer.unref?.();
  globalThis._loopBreakerCleanupTimer = timer;
}

function stableArgsString(val) {
  if (val == null) return "";
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(sortKeysDeep(JSON.parse(trimmed)));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof val === "object") {
    return JSON.stringify(sortKeysDeep(val));
  }
  return String(val);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function flattenText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return content.text || content.output || content.error || "";
  }
  return "";
}

function extractToolCallsSignature(item) {
  if (!item || typeof item !== "object") return null;

  // OpenAI Responses API item: { type: "function_call", name, arguments }
  if (item.type === "function_call" && item.name) {
    return `${item.name}:${stableArgsString(item.arguments)}`;
  }

  if (item.role !== "assistant" && item.role !== "model") return null;

  const sigs = [];
  if (Array.isArray(item.tool_calls)) {
    for (const tc of item.tool_calls) {
      const name = tc?.function?.name || tc?.name;
      if (!name) continue;
      const args = tc?.function?.arguments ?? tc?.arguments ?? tc?.input;
      sigs.push(`${name}:${stableArgsString(args)}`);
    }
  }
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (block?.type === "tool_use" && block.name) {
        sigs.push(`${block.name}:${stableArgsString(block.input)}`);
      }
    }
  }
  if (sigs.length === 0) return null;
  return sigs.sort().join("|");
}

const ERROR_TEXT_RE = /^(?:error|fatal|exception|traceback|exit code [1-9]\d*|command failed|permission denied|enoent|econnrefused|etimedout|eacces)\b/i;

function normalizeErrorSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{6,}\b/g, "#")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isErrorLikeText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (ERROR_TEXT_RE.test(trimmed)) return true;
  // Also catch lines starting with explicit error prefixes
  return trimmed.split("\n").slice(0, 5).some((line) => ERROR_TEXT_RE.test(line.trim()));
}

function extractToolErrorSignatures(item) {
  if (!item || typeof item !== "object") return { hasToolResult: false, errors: [] };

  // OpenAI Responses API tool output
  if (item.type === "function_call_output") {
    const txt = flattenText(item.output);
    const isErr = item.is_error === true || item.status === "error" || isErrorLikeText(txt);
    return { hasToolResult: true, errors: isErr ? [normalizeErrorSignature(txt || "tool_error")] : [] };
  }

  // OpenAI / generic tool or function role
  if (item.role === "tool" || item.role === "function") {
    const txt = flattenText(item.content);
    const isErr = item.is_error === true || item.status === "error" || isErrorLikeText(txt);
    return { hasToolResult: true, errors: isErr ? [normalizeErrorSignature(txt || "tool_error")] : [] };
  }

  // Claude user message containing tool_result blocks
  if (item.role === "user" && Array.isArray(item.content)) {
    const results = item.content.filter((b) => b && b.type === "tool_result");
    if (results.length > 0) {
      const errors = [];
      for (const r of results) {
        const txt = flattenText(r.content);
        if (r.is_error === true || isErrorLikeText(txt)) {
          errors.push(normalizeErrorSignature(txt || "tool_error"));
        }
      }
      return { hasToolResult: true, errors };
    }
  }

  return { hasToolResult: false, errors: [] };
}

function isPlainHumanTurn(item) {
  if (!item || item.role !== "user") return false;
  if (typeof item.content === "string") return item.content.trim().length > 0;
  if (Array.isArray(item.content)) {
    const hasToolResult = item.content.some((b) => b?.type === "tool_result");
    const hasText = item.content.some((b) => b?.type === "text" && String(b.text || "").trim().length > 0);
    return !hasToolResult && hasText;
  }
  return false;
}

function getConversationItems(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  return [];
}

function sha16(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Inspect a request before upstream dispatch to catch runaway agent loops
 * without mutating the request body or breaking prompt caching.
 */
export function detectRunawayLoop({ body, headers, now = Date.now() } = {}) {
  const rawFlag = String(process.env.LOOP_BREAKER || "on").trim().toLowerCase();
  if (rawFlag === "off" || rawFlag === "0" || rawFlag === "false") {
    return { tripped: false };
  }
  if (!body || typeof body !== "object") return { tripped: false };

  const items = getConversationItems(body);
  if (items.length === 0) return { tripped: false };

  // Check consecutive trailing tool-call and tool-error streaks in history.
  let toolRef = null;
  let toolStreak = 0;
  let toolStreakBroken = false;

  let errRef = null;
  let errStreak = 0;
  let errStreakBroken = false;

  let sawToolActivity = false;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;

    if (isPlainHumanTurn(item)) {
      break; // Human input starts a fresh segment
    }

    const callSig = extractToolCallsSignature(item);
    if (callSig) {
      sawToolActivity = true;
      if (!toolStreakBroken) {
        if (toolRef === null) {
          toolRef = callSig;
          toolStreak = 1;
        } else if (callSig === toolRef) {
          toolStreak++;
        } else {
          toolStreakBroken = true;
        }
      }
      continue;
    }

    const { hasToolResult, errors } = extractToolErrorSignatures(item);
    if (hasToolResult) {
      sawToolActivity = true;
      if (!errStreakBroken) {
        if (errors.length === 0) {
          errStreakBroken = true;
        } else {
          for (let j = errors.length - 1; j >= 0; j--) {
            const sig = errors[j];
            if (errRef === null) {
              errRef = sig;
              errStreak = 1;
            } else if (sig === errRef) {
              errStreak++;
            } else {
              errStreakBroken = true;
              break;
            }
          }
        }
      }
    }
  }

  if (toolStreak >= IDENTICAL_TOOL_STREAK) {
    return {
      tripped: true,
      reason: "identical_tool_loop",
      streak: toolStreak,
      detail: toolRef.slice(0, 140),
    };
  }

  if (errStreak >= IDENTICAL_ERROR_STREAK) {
    return {
      tripped: true,
      reason: "identical_error_loop",
      streak: errStreak,
      detail: errRef.slice(0, 140),
    };
  }

  // Layer 2: Cross-request rapid identical burst within an explicit session
  // containing tool history or multi-turn depth (avoids tripping short health pings).
  const sessionKey = extractClientSessionId(headers, body, "");
  if (sessionKey && (sawToolActivity || items.length > 2)) {
    const tailSlice = items.slice(-3).map((item) => {
      const callSig = extractToolCallsSignature(item);
      if (callSig) return `call:${callSig}`;
      const { hasToolResult, errors } = extractToolErrorSignatures(item);
      if (hasToolResult) return `res:${errors.join("|") || flattenText(item.content ?? item.output).slice(0, 120)}`;
      return `${item.role || item.type || "msg"}:${flattenText(item.content ?? item.output).slice(0, 120)}`;
    }).join("||");

    const burstSig = sha16(`${body.model || ""}|${tailSlice}`);
    const entry = burstStore.get(sessionKey);

    if (entry && now - entry.lastSeenAt <= BURST_WINDOW_MS && entry.sig === burstSig) {
      entry.count += 1;
      entry.lastSeenAt = now;
      burstStore.delete(sessionKey);
      burstStore.set(sessionKey, entry);

      if (entry.count >= SESSION_BURST_THRESHOLD) {
        return {
          tripped: true,
          reason: "session_burst_loop",
          streak: entry.count,
          detail: `session=${sessionKey}`,
        };
      }
    } else {
      if (!entry && burstStore.size >= MAX_BURST_ENTRIES) {
        const oldest = burstStore.keys().next().value;
        if (oldest !== undefined) burstStore.delete(oldest);
      } else if (entry) {
        burstStore.delete(sessionKey);
      }
      burstStore.set(sessionKey, { sig: burstSig, count: 1, lastSeenAt: now });
    }
  }

  return { tripped: false };
}

export function buildLoopBreakerErrorResponse(verdict, sourceFormat = "openai") {
  const message = `888router loop breaker stopped request (${verdict.reason}, streak=${verdict.streak}): agent repeated identical operation without progress.`;
  const payload = sourceFormat === "claude"
    ? { type: "error", error: { type: "invalid_request_error", message } }
    : {
        error: {
          message,
          type: "invalid_request_error",
          code: "loop_detected",
          reason: verdict.reason,
          streak: verdict.streak,
        },
      };

  return new Response(JSON.stringify(payload), {
    status: 400,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-888-Loop-Breaker": "tripped",
    },
  });
}

export function clearLoopBreakerStore() {
  burstStore.clear();
}
