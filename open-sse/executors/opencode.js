import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";

const KNOWN_FREE_OPENCODE_MODELS = new Set(["big-pickle"]);

// Derive Claude format models dynamically from registry metadata
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

const MESSAGES_FORMAT_MODELS = getClaudeFormatModels();

const ZEN_FREE_BASE = "https://opencode.ai/zen/v1";
const ZEN_GO_BASE = "https://opencode.ai/zen/go/v1";

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  buildUrl(model, stream = true, urlIndex = 0, credentials = null) {
    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const isFreeModel = typeof model === "string" && (model.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(model));
    const base = (key && !isFreeModel) ? ZEN_GO_BASE : ZEN_FREE_BASE;
    return MESSAGES_FORMAT_MODELS.has(model)
      ? `${base}/messages`
      : `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "", model = null) {
    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const effectiveModel = model || (typeof url === "string" && !url.startsWith("http") ? url : null);
    const isFreeModel = typeof effectiveModel === "string" && (effectiveModel.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(effectiveModel));
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-client": "desktop",
    };

    if (key && !isFreeModel) {
      // OpenCode Go with API Key
      if (effectiveModel && MESSAGES_FORMAT_MODELS.has(effectiveModel)) {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    } else {
      // OpenCode Zen Free
      headers["Authorization"] = "Bearer public";
      if (effectiveModel && MESSAGES_FORMAT_MODELS.has(effectiveModel)) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    let nextBody = injectReasoningContent({ provider: this.provider, model, body });
    // t2: OpenCode free/reasoning models (model ends with "-free" or is big-pickle) often receive no
    // max_tokens from clients (e.g. Claude Code). Upstream defaults to a low budget
    // (~40-150 tokens) which exhausts on reasoning, leaving empty text content.
    // Inject min max_tokens: 2000 when body.max_tokens is absent/undefined.
    const isFreeModel = typeof model === "string" && (model.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.has(model));
    if (isFreeModel && (nextBody?.max_tokens === undefined || nextBody?.max_tokens === null)) {
      nextBody = { ...nextBody, max_tokens: 2000 };
    }
    return nextBody;
  }
}
