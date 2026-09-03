import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";

const OPENCODE_UA = "opencode";
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

function generateRequestId() {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function generateSessionId() {
  return `ses_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Normalize any resolved id into opencode's ses_ format (stable per-conversation)
function toOpencodeSession(id) {
  const stripped = String(id || "").replace(/^ses_/, "").replace(/-/g, "");
  return stripped ? `ses_${stripped}` : null;
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

function resolveOpencodeSession(body, credentials) {
  return toOpencodeSession(resolveSessionId({
    headers: credentials?.rawHeaders,
    body,
    connectionId: credentials?.connectionId,
    scope: "opencode",
  }));
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    this._currentSessionId = null;
  }

  transformRequest(model, body, stream, credentials) {
    this._currentSessionId = resolveOpencodeSession(body, credentials);

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

    if (isResponsesModel(model)) {
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      return injectReasoningContent({ provider: this.provider, model, body });
    }

    let nextBody = injectReasoningContent({ provider: this.provider, model, body });
    // OpenCode free/reasoning models (model ends with "-free" or is big-pickle) often receive no
    // max_tokens from clients (e.g. Claude Code). Upstream defaults to a low budget
    // (~40-150 tokens) which exhausts on reasoning, leaving empty text content.
    // Inject min max_tokens: 2000 when body.max_tokens is absent/undefined.
    const isFreeModel = typeof model === "string" && (model.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(model));
    if (isFreeModel && (nextBody?.max_tokens === undefined || nextBody?.max_tokens === null)) {
      nextBody = { ...nextBody, max_tokens: 2000 };
    }
    return nextBody;
  }

  buildUrl(model, stream = true, urlIndex = 0, credentials = null) {
    if (isResponsesModel(model)) {
      const base = this.config?.baseUrl ? `${this.config.baseUrl}/zen/v1` : ZEN_FREE_BASE;
      return `${base}/responses`;
    }
    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const isFreeModel = typeof model === "string" && (model.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(model));
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
    const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");

    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const effectiveModel = model || (typeof url === "string" && !url.startsWith("http") ? url : null);
    const isFreeModel = typeof effectiveModel === "string" && (effectiveModel.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(effectiveModel));

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
      "x-opencode-client": lower["x-opencode-client"] || "desktop",
      "x-opencode-session": lower["x-opencode-session"] || this._currentSessionId || generateSessionId(),
      "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "Accept": stream ? "text/event-stream" : "*/*",
    };

    if (key && !isFreeModel) {
      // OpenCode Go with API Key
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
