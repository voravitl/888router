import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";

const OPENCODE_UA = "opencode";
const KNOWN_FREE_OPENCODE_MODELS = new Set(["big-pickle"]);

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
