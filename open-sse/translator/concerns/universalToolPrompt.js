// Universal Tool Call Schema Injector & Token Bomb Guard (Layer 1)
// Injects XML <tool_call> instructions for models that lack native function calling capabilities.

const NON_TOOL_DENYLIST = [
  "ollama",
  "deepseek-r1",
  "qwen-base",
  "llama-3",
  "mistral-base",
  "gemma"
];

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

  // "auto" mode: check if model lacks native tools or is in denylist
  const modelName = String(modelInfo.model || body.model || "").toLowerCase();
  const provider = String(modelInfo.provider || "").toLowerCase();

  const isDenylisted = NON_TOOL_DENYLIST.some(d => modelName.includes(d) || provider.includes(d));
  const lacksNativeTools = modelInfo.capabilities && modelInfo.capabilities.tools === false;

  return isDenylisted || lacksNativeTools;
}

/**
 * Compacts tool parameter schemas to prevent prompt token explosion (Token Bomb Guard)
 */
function compactParameters(params, maxLen = 1500) {
  if (!params || typeof params !== "object") return "{}";
  try {
    const str = JSON.stringify(params);
    if (str.length <= maxLen) return str;
    // Truncate non-essential description fields in properties if oversized
    const copy = JSON.parse(str);
    if (copy.properties) {
      for (const key of Object.keys(copy.properties)) {
        if (copy.properties[key] && copy.properties[key].description) {
          delete copy.properties[key].description;
        }
      }
    }
    return JSON.stringify(copy);
  } catch {
    return "{}";
  }
}

/**
 * Formats body.tools into a clean XML Preamble and injects it into the system prompt.
 */
export function injectUniversalToolPrompt(body) {
  if (!body.tools || !Array.isArray(body.tools) || body.tools.length === 0) {
    return body;
  }

  const toolLines = [];

  for (const t of body.tools) {
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

    toolLines.push(`
<tool>
<name>${name}</name>
<description>${String(desc).slice(0, 300)}</description>
<parameters>${compactParameters(params)}</parameters>
</tool>`);
  }

  const preamble = `
<available_tools>${toolLines.join("")}
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

  body._universalToolPromptInjected = true;
  return body;
}
