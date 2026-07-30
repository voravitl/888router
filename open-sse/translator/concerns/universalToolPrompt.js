// Universal Tool Call Schema Injector & Token Bomb Guard (Layer 1)
// Injects XML <tool_call> instructions for models that lack native function calling capabilities.

const NON_TOOL_PROVIDERS = new Set(["ollama"]);

const NON_TOOL_DENYLIST_EXACT = new Set([
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-free"
]);

const NON_TOOL_DENYLIST_SUFFIXES = [
  "-free",
  "-base",
  "-r1",
  "/r1",
  "r1-distill"
];

const MAX_TOOLS = 50;
const MAX_PREAMBLE_CHARS = 8000;

/**
 * Escapes special XML characters to prevent prompt injection via tool names/descriptions.
 */
function escapeXml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Determines whether to inject the Universal Tool Call Preamble into the request.
 * Mode: "auto" | "force" | "off" (Default: "auto")
 */
export function shouldInjectUniversalToolPrompt(body, modelInfo = {}, options = {}) {
  // If request has no tools, do not inject
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) {
    return false;
  }

  const mode = options.universalToolsMode || "auto";

  if (mode === "off") {
    return false;
  }

  if (mode === "force") {
    return true;
  }

  // Explicit capability override
  if (modelInfo.capabilities && modelInfo.capabilities.tools === false) {
    return true;
  }

  const modelName = String(modelInfo.model || body.model || "").toLowerCase();
  const provider = String(modelInfo.provider || "").toLowerCase();

  // Non-tool providers or denylisted open models
  if (NON_TOOL_PROVIDERS.has(provider)) {
    return true;
  }

  if (NON_TOOL_DENYLIST_EXACT.has(modelName)) {
    return true;
  }

  if (NON_TOOL_DENYLIST_SUFFIXES.some(s => modelName.endsWith(s))) {
    return true;
  }

  return false;
}

/**
 * Compacts tool parameter schemas to prevent prompt token explosion (Token Bomb Guard)
 */
function compactParameters(params, maxLen = 1500) {
  if (!params || typeof params !== "object") return "{}";
  try {
    const str = JSON.stringify(params);
    if (str.length <= maxLen) return escapeXml(str);
    const copy = JSON.parse(str);
    if (copy.properties) {
      for (const key of Object.keys(copy.properties)) {
        if (copy.properties[key] && copy.properties[key].description) {
          delete copy.properties[key].description;
        }
      }
    }
    return escapeXml(JSON.stringify(copy));
  } catch {
    return "{}";
  }
}

/**
 * Formats body.tools into a clean XML Preamble and injects it into the system prompt.
 * Also strips native `tools` and `tool_choice` fields from the request body so upstream doesn't reject them.
 */
export function injectUniversalToolPrompt(body) {
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) {
    return body;
  }

  // Keep a copy of declared tool schemas for response-side strict name matching
  body._declaredTools = body.tools;

  const toolsToInject = body.tools.slice(0, MAX_TOOLS);
  const toolLines = [];

  for (const t of toolsToInject) {
    let name = "";
    let desc = "";
    let params = {};

    if (t.function) {
      name = t.function.name;
      desc = t.function.description || "";
      params = t.function.parameters || {};
    } else if (t.name) {
      name = t.name;
      desc = t.description || "";
      params = t.input_schema || {};
    }

    if (!name) continue;

    const safeName = escapeXml(name);
    const safeDesc = escapeXml(String(desc).slice(0, 300));
    const safeParams = compactParameters(params);

    toolLines.push(`
<tool>
<name>${safeName}</name>
<description>${safeDesc}</description>
<parameters>${safeParams}</parameters>
</tool>`);
  }

  let preambleStr = toolLines.join("");
  if (preambleStr.length > MAX_PREAMBLE_CHARS) {
    preambleStr = preambleStr.slice(0, MAX_PREAMBLE_CHARS) + "\n<!-- truncated -->";
  }

  const preamble = `
<available_tools>${preambleStr}
</available_tools>

MANDATE FOR TOOL CALLS:
If you need to execute a tool, output strictly using the following XML tag format:
<tool_call>
{"name": "TOOL_NAME", "arguments": {"PARAM": "VALUE"}}
</tool_call>
Do not add conversational fluff before or after <tool_call>. Output strictly valid JSON inside <tool_call>.
`.trim();

  // Inject preamble into system prompt or prepend to first message
  if (!body.messages || !Array.isArray(body.messages)) {
    body.messages = [];
  }

  const sysMsg = body.messages.find(m => m.role === "system" || m.role === "developer");

  if (sysMsg) {
    if (typeof sysMsg.content === "string") {
      sysMsg.content = `${sysMsg.content}\n\n${preamble}`;
    } else if (Array.isArray(sysMsg.content)) {
      sysMsg.content.push({ type: "text", text: `\n\n${preamble}` });
    }
  } else {
    body.messages.unshift({ role: "system", content: preamble });
  }

  // Strip native tools and tool_choice from request so upstream doesn't receive redundant/rejected schemas
  delete body.tools;
  delete body.tool_choice;

  body._universalToolPromptInjected = true;
  return body;
}

/**
 * Removes internal private fields before body is passed to upstream executor / fetch payload.
 */
export function stripPrivateToolFields(body) {
  if (!body || typeof body !== "object") return body;
  delete body._universalToolPromptInjected;
  delete body._declaredTools;
  return body;
}
