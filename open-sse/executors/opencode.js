import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";

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
    const isFreeModel = typeof model === "string" && model.endsWith("-free");
    const base = (key && !isFreeModel) ? ZEN_GO_BASE : ZEN_FREE_BASE;
    return MESSAGES_FORMAT_MODELS.has(model)
      ? `${base}/messages`
      : `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "", model = null) {
    const rawKey = credentials?.apiKey || credentials?.accessToken;
    const key = typeof rawKey === "string" ? rawKey.trim() : null;
    const isFreeModel = typeof model === "string" && model.endsWith("-free");
    const headers = {
      "Content-Type": "application/json",
      "x-opencode-client": "desktop",
    };

    if (key && !isFreeModel) {
      // OpenCode Go with API Key
      if (model && MESSAGES_FORMAT_MODELS.has(model)) {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      } else {
        headers["Authorization"] = `Bearer ${key}`;
      }
    } else {
      // OpenCode Zen Free
      headers["Authorization"] = "Bearer public";
      if (model && MESSAGES_FORMAT_MODELS.has(model)) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    }

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  transformRequest(model, body) {
    let nextBody = injectReasoningContent({ provider: this.provider, model, body });
    // t2: OpenCode free/reasoning models (model ends with "-free") often receive no
    // max_tokens from clients (e.g. Claude Code). Upstream defaults to a low budget
    // (~40-150 tokens) which exhausts on reasoning, leaving empty text content.
    // Inject min max_tokens: 2000 when body.max_tokens is absent/undefined.
    const isFreeModel = typeof model === "string" && model.endsWith("-free");
    if (isFreeModel && (nextBody?.max_tokens === undefined || nextBody?.max_tokens === null)) {
      nextBody = { ...nextBody, max_tokens: 2000 };
    }
    return nextBody;
  }
}
