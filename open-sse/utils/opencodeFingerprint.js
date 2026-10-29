/**
 * OpenCode free-tier request fingerprint (body side).
 *
 * Ported from upstream decolua/9router ce060c79b (open-sse/utils/opencodeFingerprint.js).
 * Two body gates are mirrored here; the third gate (TLS ClientHello) lives in
 * services/opencodeTlsClient.js:
 *
 * - Tools: free-tier requests must declare OpenCode's own `read` and `shell`
 *   tools with their exact descriptions and parameter schemas; stubbed
 *   descriptions or renamed schemas are refused. Caller tools are sent
 *   untouched. A caller tool that already uses an exact fingerprint name with a
 *   different definition adopts OpenCode's definition in place when its
 *   arguments can carry it; only a genuinely different schema travels under an
 *   alias (`read_client`, ...). The alias map is returned so the executor can
 *   feed it into the existing `_toolNameMap` restore path (chatCore →
 *   restoreOpencodeToolNames) — there is no separate response-side wiring here.
 * - System prompt: the CLI's `<env>` marker must be present.
 *
 * Probe evidence (2026-10-29, scratch probe/report.md): the same impersonated
 * TLS session answered 200 with this contract and 429 FreeUsageLimitError with
 * the previous one (v1 UA, stub bash/glob/grep/read tools, no `<env>`).
 *
 * Shapes: "chat" (Chat Completions, {type, function:{...}}), "flat" (Responses,
 * {type, name, ...}; system text in `instructions`), "claude" (/messages,
 * {name, description, input_schema}; system text in top-level `system`).
 *
 * All helpers REPLACE arrays/objects on `body` instead of mutating the caller's
 * nested values; the caller passes a shallow copy so a retry re-runs cleanly.
 */
import os from "node:os";
import path from "node:path";

/** Names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

// Verbatim from the OpenCode v2.0.26 CLI (via upstream). Upstream compares
// description and parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

function schemaOf(tool) {
  const fn = chatFunctionOf(tool);
  if (fn) return fn.parameters;
  return tool?.parameters !== undefined ? tool.parameters : tool?.input_schema;
}

function descriptionOf(tool) {
  const fn = chatFunctionOf(tool);
  return fn ? fn.description : tool?.description;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key) {
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return descriptionOf(tool) === want.description
    && JSON.stringify(schemaOf(tool)) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * True when `tool` already speaks OpenCode's parameter names for `key`, so the
 * fingerprint definition can replace its own without hiding or adding an
 * argument the caller's handler expects (e.g. the same tool whose description
 * says "Windows using pwsh" instead of "Linux using bash").
 */
function canNormalizeInPlace(tool, key) {
  const props = schemaOf(tool)?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  const wanted = Object.keys(FINGERPRINT_TOOL_DEFINITIONS[key].parameters.properties);
  const declared = Object.keys(props);
  if (declared.some((name) => !wanted.includes(name))) return false;
  return FINGERPRINT_TOOL_DEFINITIONS[key].parameters.required.every((name) => declared.includes(name));
}

function withFingerprintDefinition(tool, key) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[key];
  const fn = chatFunctionOf(tool);
  if (fn) return { ...tool, function: { ...fn, description, parameters } };
  if (tool.input_schema !== undefined && tool.parameters === undefined) {
    return { ...tool, description, input_schema: parameters };
  }
  return { ...tool, description, parameters };
}

/**
 * Keep caller tools on the fingerprint names whenever their arguments can carry
 * OpenCode's, and move the remaining ones off them so the exact definitions can
 * be appended without a duplicate name. Everything else (including case
 * variants such as `Read`) is preserved verbatim.
 *
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools: Array.isArray(tools) ? [...tools] : tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }
    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }
    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }
    if (canNormalizeInPlace(tool, key)) {
      out.push(withFingerprintDefinition(tool, key));
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, shape) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    if (shape === "flat") tools.push({ type: "function", name, description, parameters, strict: false });
    else if (shape === "claude") tools.push({ name, description, input_schema: parameters });
    else tools.push({ type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the
 * model reads its own earlier calls as calls to OpenCode's tool of that name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item);
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (Array.isArray(msg?.tool_calls)) {
        return {
          ...msg,
          tool_calls: msg.tool_calls.map((call) =>
            aliases.has(call?.function?.name)
              ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
              : call),
        };
      }
      // Claude history: assistant tool_use blocks.
      if (Array.isArray(msg?.content) && msg.content.some((b) => b?.type === "tool_use" && aliases.has(b.name))) {
        return {
          ...msg,
          content: msg.content.map((b) =>
            b?.type === "tool_use" && aliases.has(b.name) ? { ...b, name: aliases.get(b.name) } : b),
        };
      }
      return msg;
    });
  }
}

// The marker gate reads text only: a foreign system prompt plus this exact
// block passes, so the marker is appended to the caller's own prompt rather
// than replacing it.
const ENV_TAG = "<env>";
const ENV_HEADING = "Here is some useful information about the environment you are running in:";
const ENV_TMP_DIR = path.join(os.tmpdir(), "opencode");
const ENV_WORKING_DIR = process.cwd();
const ENV_FINGERPRINT_PROMPT = [
  ENV_HEADING,
  ENV_TAG,
  `  Working directory: ${ENV_WORKING_DIR}`,
  `  Workspace root folder: ${ENV_WORKING_DIR}`,
  "  Is directory a git repo: no",
  `  Platform: ${process.platform}`,
  `  Prefer ${ENV_TMP_DIR} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
  "</env>",
].join("\n");

function systemCarriesEnv(system) {
  if (typeof system === "string") return system.includes(ENV_TAG);
  if (Array.isArray(system)) {
    return system.some((block) => typeof block?.text === "string" && block.text.includes(ENV_TAG));
  }
  return false;
}

/** Append `text` to a system prompt held as a string, text blocks, or unset. */
function appendSystemText(system, text) {
  if (typeof system === "string") {
    return system.trim() ? `${system}\n\n${text}` : text;
  }
  const blocks = Array.isArray(system) ? [...system] : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (typeof block?.text === "string") {
      blocks[i] = { ...block, text: block.text.trim() ? `${block.text}\n\n${text}` : text };
      return blocks;
    }
  }
  return [...blocks, { type: "text", text }];
}

// Without "must not be used" descriptions the model may call the appended
// tools, so tell it in the system prompt instead (upstream wording).
function noteUnavailableTools(body, shape, names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (shape === "flat") {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  if (shape === "claude" || body.system !== undefined) {
    body.system = appendSystemText(body.system, note);
    return;
  }
  if (!Array.isArray(body.messages)) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Append the CLI's environment marker without replacing the caller's content.
 * Fail-open: a surprising body is left untouched.
 * @returns {boolean} true when the marker was added
 */
export function applyEnvFingerprint(body, shape) {
  try {
    if (!body || typeof body !== "object") return false;

    if (shape === "flat") {
      if (body.instructions !== undefined && typeof body.instructions !== "string") return false;
      if (systemCarriesEnv(body.instructions)) return false;
      body.instructions = (typeof body.instructions === "string" && body.instructions.trim())
        ? `${body.instructions}\n\n${ENV_FINGERPRINT_PROMPT}`
        : ENV_FINGERPRINT_PROMPT;
      return true;
    }

    if (shape === "claude" || body.system !== undefined) {
      if (systemCarriesEnv(body.system)) return false;
      body.system = appendSystemText(body.system, ENV_FINGERPRINT_PROMPT);
      return true;
    }

    if (!Array.isArray(body.messages)) return false;
    const idx = body.messages.findIndex((msg) => msg?.role === "system");
    if (idx >= 0) {
      const target = body.messages[idx];
      if (systemCarriesEnv(target.content)) return false;
      const content = appendSystemText(target.content, ENV_FINGERPRINT_PROMPT);
      body.messages = body.messages.map((msg, i) => (i === idx ? { ...msg, content } : msg));
      return true;
    }
    body.messages = [{ role: "system", content: ENV_FINGERPRINT_PROMPT }, ...body.messages];
    return true;
  } catch {
    return false;
  }
}

/**
 * Full request-side pass for one free-lane body (mutates `body`'s own
 * top-level fields only — pass a shallow copy).
 *
 * @param {object} body
 * @param {"chat"|"flat"|"claude"} shape
 * @returns {Map<string,string>} sent name -> caller's original name (aliases only)
 */
export function applyFingerprintTools(body, shape = "chat") {
  if (!body || typeof body !== "object") return new Map();

  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, shape);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, shape, appended);

  // The `<env>` marker is required on every free-lane request, with or without tools.
  applyEnvFingerprint(body, shape);

  // Responses keeps its explicit auto default. Never default to "none".
  if (!body.tool_choice && shape === "flat") body.tool_choice = "auto";

  return map;
}

export const __test__ = { FINGERPRINT_TOOL_DEFINITIONS, ENV_TAG, ENV_FINGERPRINT_PROMPT };
