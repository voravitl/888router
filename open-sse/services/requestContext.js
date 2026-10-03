import { resolveKnownLimits } from "../providers/capabilities.js";
import { parseModel, stripContextSuffix } from "./model.js";

// A routing estimate, not a provider tokenizer. Unicode text must not be
// treated as four characters per token; encoded media has separate billing.
function textTokens(value) {
  let ascii = 0;
  let unicode = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 128) ascii++;
    else {
      unicode++;
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
        && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i++;
    }
  }
  return ascii / 4 + unicode;
}

function countInput(value) {
  if (value == null) return 0;
  if (typeof value === "string") return textTokens(value);
  if (typeof value === "number" || typeof value === "boolean") return textTokens(String(value));
  if (Array.isArray(value)) return value.reduce((total, item) => total + countInput(item), 0);
  if (typeof value !== "object") return 0;
  // Base64/URLs do not have the same token cost as text. The provider remains
  // authoritative for images/audio/video/documents and opaque reasoning state.
  return Object.entries(value).reduce((total, [key, item]) => {
    const mediaSource = key === "source" && ["image", "document", "audio", "video"].includes(value.type)
      && item && typeof item === "object" && ["base64", "url"].includes(item.type);
    const mediaPart = ["inlineData", "inline_data", "fileData", "file_data"].includes(key)
      && item && typeof item === "object" && (item.mimeType || item.mime_type);
    const mediaBlock = (key === "image_url" && ["image_url", "input_image"].includes(value.type))
      || (key === "input_audio" && value.type === "input_audio");
    const fileBlock = (key === "file_data" && value.type === "input_file")
      || (key === "file" && value.type === "file");
    const opaqueState = (key === "signature" && value.type === "thinking")
      || (key === "encrypted_content" && value.type === "reasoning");
    return total + (mediaSource || mediaPart || mediaBlock || fileBlock || opaqueState ? 0 : textTokens(key) + countInput(item));
  }, 4);
}

export function estimateRequestTokens(body = {}) {
  const fields = ["messages", "input", "instructions", "system", "tools", "functions", "contents", "systemInstruction", "system_instruction", "prompt", "conversationState", "response_format", "text"];
  const total = fields.reduce((sum, key) => sum + countInput(body?.[key]), 0);
  const config = body?.generationConfig || body?.generation_config;
  const schemas = countInput(config?.responseSchema) + countInput(config?.responseJsonSchema)
    + countInput(config?.response_schema) + countInput(config?.response_json_schema);
  return Math.ceil(total + schemas + (body?.request && typeof body.request === "object" ? estimateRequestTokens(body.request) : 0));
}

export function reservedOutputTokens(body = {}) {
  const values = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens,
    body.generationConfig?.maxOutputTokens, body.generation_config?.max_output_tokens,
    body.inferenceConfig?.maxTokens, body.request?.generationConfig?.maxOutputTokens];
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  return valid.length ? Math.ceil(Math.max(...valid)) : 0;
}

// Translators can insert defaults or increase tool budgets. Keep an explicit
// client reservation intact; only gateway-generated defaults may be capped.
export function alignTranslatedOutputBudget(translated, original, ref) {
  const requested = reservedOutputTokens(original);
  const { maxOutput } = getDeclaredModelLimits(ref);
  const fields = [[translated, "max_tokens"], [translated, "max_completion_tokens"],
    [translated, "max_output_tokens"], [translated.generationConfig, "maxOutputTokens"],
    [translated.generation_config, "max_output_tokens"], [translated.inferenceConfig, "maxTokens"],
    [translated.request?.generationConfig, "maxOutputTokens"]];
  for (const [container, key] of fields) {
    const value = container?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (requested) container[key] = requested;
    else if (maxOutput && value > maxOutput) container[key] = maxOutput;
  }
}

export function getDeclaredModelLimits(ref) {
  const parsed = typeof ref === "string" ? parseModel(ref) : ref;
  return resolveKnownLimits(parsed?.provider, stripContextSuffix(parsed?.model));
}

export function getContextFit(body, ref, estimatedInputTokens = estimateRequestTokens(body)) {
  const { contextWindow, maxOutput } = getDeclaredModelLimits(ref);
  const reserved = reservedOutputTokens(body);
  const reason = maxOutput && reserved > maxOutput ? "output_limit_exceeded"
    : contextWindow && estimatedInputTokens + reserved > contextWindow ? "context_length_exceeded" : null;
  return {
    fits: reason ? false : contextWindow ? true : null,
    estimatedInputTokens,
    reservedOutputTokens: reserved,
    contextWindow,
    maxOutput,
    reason,
  };
}

export function contextLimitMessage(fit) {
  return fit.reason === "output_limit_exceeded"
    ? `Requested output budget ${fit.reservedOutputTokens} exceeds declared model output limit ${fit.maxOutput}.`
    : `Estimated input (${fit.estimatedInputTokens}) plus requested output (${fit.reservedOutputTokens}) exceeds declared context window (${fit.contextWindow}). Token estimates are approximate; use a larger-context model or compact the request explicitly.`;
}
