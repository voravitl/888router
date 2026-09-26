import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OPENCODE_RESPONSES_MIN_OUTPUT_TOKENS } from "../config/runtimeConfig.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { detectClientTool } from "../utils/clientDetector.js";
import { sanitizeOpencodeTools } from "../utils/opencodeToolSanitizer.js";

// Ported from upstream decolua/9router#4105: OpenCode Console validates the
// free-tier client identity server-side. `Authorization: Bearer public`
// requests need BOTH a versioned UA (opencode/<version>, version >= 1.17.0)
// AND a canonical session id; bare "opencode" UA or UUID-style sessions get
// 403 FreeTierError ("only be used from within OpenCode").
const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Upstream free-tier gate (verified live 2026-09-18, cf. decolua/9router#4132):
// /zen/v1/chat/completions and /zen/v1/responses with
// `Authorization: Bearer public` reject requests that do not look like the
// official OpenCode agentic client, even when User-Agent/session shape are
// valid. Concretely enforced:
// - stream must be true (stream:false → 403 FreeTierError);
// - tools must include the file-search quartet {bash, glob, grep, read}
//   (0–3 of them → 403; extras are allowed). Plain chat callers send no
//   tools, so without injection every such request 403s.
const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

export function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}
const KNOWN_FREE_OPENCODE_MODELS = new Set(["big-pickle"]);

// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isResponsesPath(model, credentials) {
  return isResponsesModel(model) || credentials?.runtimeTransport?.format === "openai-responses";
}

// Zen-free routing (`-free` / big-pickle → Bearer public on /zen/v1) must not
// apply to opencode-go: Go catalog ids are paid (Bearer user key), never Zen
// public models — regardless of any -free suffix they may carry.
function isZenFreeModel(provider, model) {
  if (provider === "opencode-go") return false;
  // Strip thinking suffixes ("mimo-v2.5-free(high)") before matching.
  const base = baseModelId(model);
  return base.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(base);
}

function runtimeTransportUrl(credentials) {
  const rt = credentials?.runtimeTransport;
  if (!rt?.baseUrl) return null;
  return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

const getClaudeFormatModels = () => {
  const models = PROVIDERS.opencode?.models || [];
  const claudeModels = models.filter((m) => m.targetFormat === "claude").map((m) => m.id);
  return new Set(claudeModels.length ? claudeModels : [
    "minimax-m3",
    "minimax-m2.7",
    "minimax-m2.5",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
  ]);
};

const MESSAGES_MODELS = getClaudeFormatModels();

const ZEN_FREE_BASE = "https://opencode.ai/zen/v1";
const ZEN_GO_BASE = "https://opencode.ai/zen/go/v1";

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Canonical descending session id: ses_ + 12 hex timestamp chars + 14 Base62.
export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

// Deterministically map a foreign session identity (claude/codex UUIDs,
// hashes) into a canonical ses_ id so multi-turn prompt caching survives.
export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
  const raw = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
  return raw.trim();
}

// Merge the upstream-mandated file-search quartet into Chat Completions
// bodies. Caller tools are preserved verbatim (extras are allowed upstream);
// only the missing fingerprint names are appended as no-op declarations the
// model may ignore. Without this, plain chat callers that send no tools get
// 403 FreeTierError on every request.
function ensureChatFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      function: {
        name,
        description: `OpenCode built-in ${name} tool`,
        parameters: { type: "object", properties: {} },
      },
    });
    present.add(name);
  }
}

// Same fingerprint for the Responses flat tool shape
// ({type:"function", name, ...}).
function ensureResponsesFingerprintTools(body) {
  if (!body || typeof body !== "object") return;
  const present = new Set();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      const name = toolNameOf(tool);
      if (name) present.add(name);
    }
  } else {
    body.tools = [];
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push({
      type: "function",
      name,
      description: `OpenCode built-in ${name} tool`,
      parameters: { type: "object", properties: {} },
    });
    present.add(name);
  }
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const resolved = incoming || normalizeSession(providerSessionId) || resolveSessionId({
    headers,
    body: body && typeof body === "object" ? body : {},
    connectionId: credentials?.connectionId,
    scope: "opencode",
  });

  return resolved ? translateSessionId(resolved, clientTool) : generateSessionId();
}

const TEXT_PART_TYPES = new Set(["text", "input_text"]);

function partText(p) {
  if (typeof p === "string") return p;
  if (p && typeof p.text === "string") return p.text;
  return "";
}

// OpenCode Zen HTTP 400s on content: [] and text parts with null/missing text
// (observed on muse-spark-1.2-contributor-free). chatCore strips modalities
// before this runs and injects text placeholders, so image-only does not
// become []. Mixed/image arrays are left for that strip; valid text-part
// arrays are left untouched. Collapse [null]/bare strings/unknown text-only.
function sanitizeOpencodeMessageContent(content) {
  if (!Array.isArray(content)) return content;
  if (content.length === 0) return "";
  const hasNonText = content.some((p) => p && typeof p === "object" && p.type && !TEXT_PART_TYPES.has(p.type));
  if (hasNonText) return content;
  if (content.every((p) => p && typeof p.text === "string")) return content;
  return content.map(partText).filter((t) => t.length > 0).join("\n");
}

function clampResponsesMaxOutputTokens(body) {
  const n = Number(body.max_output_tokens);
  if (Number.isFinite(n) && n < OPENCODE_RESPONSES_MIN_OUTPUT_TOKENS) {
    body.max_output_tokens = OPENCODE_RESPONSES_MIN_OUTPUT_TOKENS;
  }
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor(provider = "opencode") {
    // Always bind Zen config for muse-spark URL assembly (`baseUrl` + `/zen/v1`).
    // Provider id still distinguishes the Go instance so `-free`-suffixed Go
    // ids are not treated as Zen-public.
    super(provider, PROVIDERS.opencode);
  }

  // Request-local session (no shared instance state): resolved per execute()
  // call so concurrent requests cannot leak sessions into each other.
  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const rawHeaders = sourceCredentials?.rawHeaders || {};
    const tool = clientTool || detectClientTool(rawHeaders, body || {});
    const resolved = resolveOpencodeSession(body, sourceCredentials, providerSessionId, tool);
    return {
      ...sourceCredentials,
      [SESSION_FIELD]: resolved,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object") return body;
    // Free-tier gates below apply to Zen -free models only (never Go/paid):
    // upstream documents the identity/stream/tool checks against
    // `Authorization: Bearer public` free traffic.
    const freeGate = isZenFreeModel(this.provider, model);
    if (freeGate) {
      // Upstream rejects non-streaming free-tier requests with 403 even when
      // everything else is valid. chatCore forces SSE upstream for forceStream
      // providers and converts back for non-stream clients, so always send
      // stream:true here.
      body.stream = true;
    }

    // Sanitize messages: OpenCode Zen HTTP 400s on content: null/undefined/[] and
    // text parts with null/missing text. Assistant turns with non-empty tool_calls
    // may omit content; leave that shape alone.
    if (Array.isArray(body?.messages)) {
      body = {
        ...body,
        messages: body.messages.map((m) => {
          if (!m) return m;
          const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if ((m.content === null || m.content === undefined) && !hasToolCalls) {
            return { ...m, content: "" };
          }
          if (m.role === "tool" && (m.content === null || m.content === undefined)) {
            return { ...m, content: "" };
          }
          if (m.content === null || m.content === undefined) return m;
          const content = sanitizeOpencodeMessageContent(m.content);
          return content === m.content ? m : { ...m, content };
        }),
      };
    }

    if (isResponsesPath(model, credentials)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      // OpenAI Responses / OpenCode Console: max_output_tokens must be >= 16.
      // Claude Code `/model` probes send max_tokens: 1, which Anthropic accepts.
      clampResponsesMaxOutputTokens(body);
      normalizeOpencodeReasoning(model, body);
      if (freeGate) ensureResponsesFingerprintTools(body);
      const injected = injectReasoningContent({ provider: this.provider, model, body });
      const toolMap = sanitizeOpencodeTools(injected);
      if (toolMap?.size > 0) injected._toolNameMap = toolMap;
      return injected;
    }

    let nextBody = injectReasoningContent({ provider: this.provider, model, body });
    // OpenCode free/reasoning models (model ends with "-free" or is big-pickle) often receive no
    // max_tokens from clients (e.g. Claude Code). Upstream defaults to a low budget
    // (~40-150 tokens) which exhausts on reasoning, leaving empty text content.
    // Inject min max_tokens: 2000 when body.max_tokens is absent/undefined.
    const freeSuffix = baseModelId(model);
    const isFreeModel = freeSuffix.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(freeSuffix);
    if (isFreeModel && (nextBody?.max_tokens === undefined || nextBody?.max_tokens === null)) {
      nextBody = { ...nextBody, max_tokens: 2000 };
    }
    if (freeGate) ensureChatFingerprintTools(nextBody);
    const chatToolMap = sanitizeOpencodeTools(nextBody);
    if (chatToolMap?.size > 0) nextBody._toolNameMap = chatToolMap;
    return nextBody;
  }

  async execute(args) {
    return super.execute({ ...args, credentials: this.prepareRequestCredentials(args) });
  }

  buildUrl(model, stream = true, urlIndex = 0, credentials = null) {
    const rtUrl = runtimeTransportUrl(credentials);
    if (rtUrl) return rtUrl;
    if (isResponsesModel(model)) {
      const base = this.config?.baseUrl ? `${this.config.baseUrl}/zen/v1` : ZEN_FREE_BASE;
      return `${base}/responses`;
    }
    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const isFreeModel = isZenFreeModel(this.provider, model);
    const base = (key && !isFreeModel) ? ZEN_GO_BASE : (this.config?.baseUrl ? `${this.config.baseUrl}/zen/v1` : ZEN_FREE_BASE);
    return MESSAGES_MODELS.has(model)
      ? `${base}/messages`
      : `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "", model = null) {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = hasValidOpencodeVersion(downstreamUa);

    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const effectiveModel = model || (typeof url === "string" && !url.startsWith("http") ? url : null);
    const rtAuth = credentials?.runtimeTransport?.auth;
    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": session,
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      // Live-verified: Console serves the free tier on streaming requests
      // only. Non-stream chat completions (and /responses without
      // "stream": true) get 403 FreeTierError with identical identity.
      "Accept": stream ? "text/event-stream" : "*/*",
    };

    if (rtAuth && key) {
      if (rtAuth.header === "x-api-key" || rtAuth.scheme === "raw") {
        headers["x-api-key"] = key;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
      if (rtAuth.anthropicVersion) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    } else if (key) {
      // User-supplied key (BYOK). Zen keys authenticate -free models on
      // /zen/v1 (anonymous Bearer public is 403-blocked for third-party
      // clients with FreeTierError). Go provider ids never reach this branch
      // as free models (isZenFreeModel is false for opencode-go).
      if (effectiveModel && MESSAGES_MODELS.has(effectiveModel)) {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    } else {
      // OpenCode Zen Free
      headers["Authorization"] = "Bearer public";
      if (effectiveModel && MESSAGES_MODELS.has(effectiveModel)) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    }

    return headers;
  }
}

export default OpenCodeExecutor;
