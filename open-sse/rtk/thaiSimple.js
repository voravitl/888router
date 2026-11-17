import { injectSystemPrompt } from "./systemInject.js";

export const THAI_SIMPLE_MODES = {
  OFF: "off",
  AUTO: "auto",
  ALL: "all",
};

const VALID_MODES = new Set(Object.values(THAI_SIMPLE_MODES));

// Optimized Thai-Simple system instruction (~160 tokens, static across turns for Prompt Cache stability):
// - Answer-first, visual-first (table <= 3 short columns for TUI readability, compact ASCII flow when useful)
// - Active natural Thai syntax without passive English-translation stiffness or forced gender particles
// - Exact code/identifiers/paths/errors, strict non-invention of results, and anti-Chinese/English-drift guard
export const THAI_SIMPLE_PROMPT = [
  "Response style rule: If the user writes in Thai or requests Thai, answer in clear, everyday Thai that a busy reader understands in one glance; otherwise reply cleanly in the user's language.",
  "Lead the first sentence with the direct answer, verdict, or decision, followed only by essential cause-and-effect or concrete next steps (skip filler and repeated apologies).",
  "Use natural active Thai phrasing rather than literal English translation structures, and match the existing persona without forcing gendered particles.",
  "Format by shape: use 2-4 plain sentences for simple facts/yes-no, numbered steps for procedures, a compact ASCII diagram for flows, and tables with at most 3 short columns only when comparing options.",
  "Do not leak Chinese or unnecessary English prose; keep code blocks, identifiers, file paths, flags, numbers, URLs, and error strings exact.",
  "Never invent test results, numbers, or causes — distinguish clearly what was observed versus untested.",
].join(" ");

const EXISTING_THAI_RULE_RE =
  /(?:thai-simple|thai-communication|clear thai communication|reply in thai that a busy|น้องฟ้าใส|ตอบ(?:เป็น)?ภาษาไทย)/i;

export function normalizeThaiSimpleMode(value) {
  if (typeof value !== "string") return THAI_SIMPLE_MODES.OFF;
  const clean = value.trim().toLowerCase();
  return VALID_MODES.has(clean) ? clean : THAI_SIMPLE_MODES.OFF;
}

function getHeaderCaseInsensitive(headers, targetName) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return String(headers.get(targetName) || "").trim();
  }
  const needle = targetName.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === needle && val != null) {
      return String(val).trim();
    }
  }
  return "";
}

function checkJsonFlags(body) {
  if (!body || typeof body !== "object") return false;
  const rfType = String(body.response_format?.type || "").toLowerCase();
  if (rfType === "json_object" || rfType === "json_schema") return true;
  const textType = String(body.text?.format?.type || "").toLowerCase();
  if (textType === "json_object" || textType === "json_schema") return true;

  const genCfg = body.generationConfig || body.request?.generationConfig;
  if (genCfg && typeof genCfg === "object") {
    if (String(genCfg.responseMimeType || "").toLowerCase() === "application/json") return true;
    if (genCfg.responseSchema) return true;
  }
  return false;
}

export function hasStructuredJsonResponse(body, originalBody = null) {
  return checkJsonFlags(body) || checkJsonFlags(originalBody);
}

function collectSystemTexts(body) {
  if (!body || typeof body !== "object") return [];
  const out = [];
  const pushContent = (val) => {
    if (typeof val === "string" && val) {
      out.push(val);
    } else if (Array.isArray(val)) {
      for (const part of val) {
        if (typeof part === "string" && part) out.push(part);
        else if (part && typeof part.text === "string" && part.text) out.push(part.text);
      }
    }
  };

  pushContent(body.instructions);
  pushContent(body.system);

  const geminiSys =
    body.systemInstruction ||
    body.system_instruction ||
    body.request?.systemInstruction ||
    body.request?.system_instruction;
  if (geminiSys?.parts) pushContent(geminiSys.parts);

  const list = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : null;
  if (list) {
    for (const msg of list) {
      if (msg && (msg.role === "system" || msg.role === "developer")) {
        pushContent(msg.content);
      }
    }
  }
  return out;
}

export function hasExistingThaiStyleRule(body, originalBody = null) {
  const texts = [...collectSystemTexts(body), ...collectSystemTexts(originalBody)];
  return texts.some((txt) => txt.includes(THAI_SIMPLE_PROMPT) || EXISTING_THAI_RULE_RE.test(txt));
}

function isLowOutputProbe(body, originalBody = null) {
  const check = (b) => {
    if (!b || typeof b !== "object") return false;
    const raw =
      b.max_tokens ??
      b.max_completion_tokens ??
      b.max_output_tokens ??
      b.generationConfig?.maxOutputTokens ??
      b.request?.generationConfig?.maxOutputTokens;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 64;
  };
  return check(body) || check(originalBody);
}

function hasUserTurn(body, originalBody = null) {
  const check = (b) => {
    if (!b || typeof b !== "object") return false;
    if (typeof b.input === "string" && b.input.trim().length > 0) return true;
    const msgs = Array.isArray(b.messages) ? b.messages : Array.isArray(b.input) ? b.input : null;
    if (msgs && msgs.some((m) => m && m.role !== "system" && m.role !== "developer")) return true;
    const contents = Array.isArray(b.contents)
      ? b.contents
      : Array.isArray(b.request?.contents)
        ? b.request.contents
        : null;
    if (contents && contents.some((c) => c && c.role !== "model")) return true;
    return false;
  };
  return check(body) || check(originalBody);
}

export function shouldInjectThaiSimple({
  mode = THAI_SIMPLE_MODES.OFF,
  body = null,
  originalBody = null,
  clientTool = null,
  preserveClaudeClientInput = false,
  headers = null,
} = {}) {
  // Always protect Claude Code passthrough so Prompt Cache stays 100% intact
  if (preserveClaudeClientInput || clientTool === "claude") return false;

  const headerOverride = getHeaderCaseInsensitive(headers, "x-888-output-style").toLowerCase();
  if (headerOverride === "off" || headerOverride === "none" || headerOverride === "false" || headerOverride === "0") {
    return false;
  }

  let effectiveMode = normalizeThaiSimpleMode(mode);
  if (headerOverride === "thai-simple") {
    effectiveMode = THAI_SIMPLE_MODES.ALL;
  }

  if (effectiveMode === THAI_SIMPLE_MODES.OFF) return false;
  if (effectiveMode === THAI_SIMPLE_MODES.AUTO && clientTool === "hermes") return false;
  if (hasStructuredJsonResponse(body, originalBody)) return false;
  if (isLowOutputProbe(body, originalBody)) return false;
  if (!hasUserTurn(body, originalBody)) return false;
  if (hasExistingThaiStyleRule(body, originalBody)) return false;

  return true;
}

export function injectThaiSimple(body, format, options = {}) {
  if (!shouldInjectThaiSimple({ ...options, body })) return false;
  injectSystemPrompt(body, format, THAI_SIMPLE_PROMPT);
  return true;
}
