/**
 * Concern: Smart Intent-Based Router (Opt-in Strategy)
 * Classifies prompt complexity (Fast vs Heavy intent) and routes requests to optimal model tiers
 * when opt-in header (x-888-auto-route: true) or intent header (x-intent: auto|fast|heavy) is present.
 */

// Word boundary regex for fast indicators to prevent substring false positives (e.g. "quicksort" matching "quick")
const FAST_REGEX = /\b(explain|what is|format|typo|summarize|convert|translate|comment|docstring|simple|quick|นิยาม|คืออะไร|แปล|สรุป)\b/i;

// Word boundary regex for heavy indicators to prevent false positives (e.g. "exceptional" matching "exception")
const HEAVY_REGEX = /\b(architecture|refactor|debug|stacktrace|exception|deadlock|race condition|algorithm|benchmark|optimize performance|redesign|ออกแบบ|สถาปัตยกรรม|แก้บั๊ก|วิเคราะห์)\b/i;

const STACK_TRACE_REGEX = /(at\s+[a-zA-Z0-9_$./]+\.[a-zA-Z0-9]+:\d+|Traceback\s+\(most\s+recent\s+call\s+last\)|Uncaught\s+[a-zA-Z]+Error)/i;

/**
 * Classify request complexity into 'fast', 'heavy', or 'standard'
 */
export function classifyRequestIntent(body) {
  if (!body || typeof body !== "object") return "standard";

  const messages = body.messages || body.input || body.contents || [];
  if (!Array.isArray(messages) || messages.length === 0) return "standard";

  // Inspect last user prompt
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const role = String(msg.role || msg.author || "").toLowerCase();
    if (role === "user") {
      if (typeof msg.content === "string") {
        lastUserText = msg.content;
        break;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter(p => p && typeof p.text === "string").map(p => p.text);
        lastUserText = textParts.join(" ");
        break;
      } else if (Array.isArray(msg.parts)) {
        const textParts = msg.parts.filter(p => p && typeof p.text === "string").map(p => p.text);
        lastUserText = textParts.join(" ");
        break;
      }
    }
  }

  if (!lastUserText || typeof lastUserText !== "string") return "standard";

  const textTrimmed = lastUserText.trim();

  // Heavy indicators: stack traces, explicit heavy word boundaries, or prompt length > 4000 chars
  if (STACK_TRACE_REGEX.test(textTrimmed) || HEAVY_REGEX.test(textTrimmed) || textTrimmed.length > 4000) {
    return "heavy";
  }

  // Fast indicators: short prompt (< 300 chars) AND MUST contain explicit fast keyword boundary
  // Strict rule: Never classify as fast based on low word count alone to avoid misrouting short complex queries
  if (textTrimmed.length < 300 && FAST_REGEX.test(textTrimmed)) {
    return "fast";
  }

  return "standard";
}

/**
 * Dynamically map model names within the same family (supports future model versions dynamically)
 */
function resolveDynamicFamilyModel(currentModel, intent) {
  if (!currentModel || typeof currentModel !== "string") return currentModel;
  const modelLower = currentModel.toLowerCase();

  if (intent === "fast") {
    // Anthropic family: claude-X-sonnet / claude-X-opus -> claude-X-haiku (or default claude-3-5-haiku)
    if (modelLower.includes("claude-") && (modelLower.includes("sonnet") || modelLower.includes("opus"))) {
      const dynamicHaiku = currentModel.replace(/sonnet|opus/i, "haiku");
      return dynamicHaiku !== currentModel ? dynamicHaiku : "claude-3-5-haiku";
    }
    // OpenAI family: gpt-4o / gpt-5 -> gpt-X-mini
    if (modelLower.startsWith("gpt-") && !modelLower.includes("mini") && !modelLower.includes("nano")) {
      return modelLower.includes("gpt-4o") ? "gpt-4o-mini" : `${currentModel}-mini`;
    }
    // Gemini family: gemini-X-pro / gemini-X-flash -> gemini-X-flash-lite
    if (modelLower.includes("gemini-")) {
      if (modelLower.includes("-pro")) return currentModel.replace(/-pro/i, "-flash-lite");
      if (modelLower.includes("-flash") && !modelLower.includes("-lite")) return currentModel.replace(/-flash/i, "-flash-lite");
    }
  } else if (intent === "heavy") {
    // Anthropic family: claude-X-haiku -> claude-X-sonnet
    if (modelLower.includes("claude-") && modelLower.includes("haiku")) {
      const dynamicSonnet = currentModel.replace(/haiku/i, "sonnet");
      return dynamicSonnet !== currentModel ? dynamicSonnet : "claude-3-7-sonnet";
    }
    // OpenAI family: gpt-X-mini -> gpt-X
    if (modelLower.startsWith("gpt-") && modelLower.includes("-mini")) {
      return currentModel.replace(/-mini/i, "");
    }
    // Gemini family: gemini-X-flash-lite -> gemini-X-flash
    if (modelLower.includes("gemini-") && modelLower.includes("-flash-lite")) {
      return currentModel.replace(/-flash-lite/i, "-flash");
    }
  }

  return currentModel;
}

/**
 * Opt-in Intent-Based Model Routing (Dynamic Same-Family Mapping)
 * @param {object} body - Request body
 * @param {string} currentModel - Model currently requested
 * @param {object} headers - HTTP request headers
 * @returns {object} { model: string, stats: object }
 */
export function routeByIntent(body, currentModel, headers = {}) {
  if (!currentModel || typeof currentModel !== "string") {
    return { model: currentModel, stats: { routed: false, intent: "none", originalModel: currentModel } };
  }

  const autoRouteHeader = String(headers["x-888-auto-route"] || headers["x-auto-route"] || "").toLowerCase();
  const explicitIntentHeader = String(headers["x-intent"] || "").toLowerCase();

  // Strict Opt-in Allowlist
  const isOptIn = (autoRouteHeader === "true" || autoRouteHeader === "1") ||
                  ["auto", "fast", "heavy"].includes(explicitIntentHeader) ||
                  (body && body._autoRoute === true);

  if (!isOptIn) {
    return { model: currentModel, stats: { routed: false, intent: "none", originalModel: currentModel } };
  }

  let intent = explicitIntentHeader;
  if (!intent || intent === "auto" || !["fast", "heavy", "standard"].includes(intent)) {
    intent = classifyRequestIntent(body);
  }

  const routedModel = resolveDynamicFamilyModel(currentModel, intent);
  const routed = routedModel !== currentModel;

  const stats = {
    routed,
    intent,
    originalModel: currentModel,
    routedModel,
    reason: routed ? `Opt-in intent router mapped '${currentModel}' -> '${routedModel}' (intent: ${intent})` : "model preserved"
  };

  // DO NOT mutate request body to prevent upstream schema rejection
  return { model: routedModel, stats };
}
