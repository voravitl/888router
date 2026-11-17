"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const PROVIDER_NAME = "9router";
const API_KEY_ENV = "OPENAI_API_KEY";

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

// Match top-level "model:" and "providers:" blocks (until next non-indented, non-empty line)
const MODEL_BLOCK_RE = /^model:[ \t]*(?:\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)|\{\}[ \t]*\r?\n?)/m;
const PROVIDERS_BLOCK_RE = /^providers:[ \t]*(?:\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)|\{\}[ \t]*\r?\n?)/m;
const PROVIDER_888_SUB_RE = /^[ \t]{2}["']?888router["']?:[ \t]*(?:\r?\n((?:[ \t]{4,}.*\r?\n?|[ \t]*\r?\n)*)|\{\}[ \t]*\r?\n?)/m;

const unquoteYamlScalar = (raw) => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end !== -1) return trimmed.slice(1, end) || null;
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end !== -1) return trimmed.slice(1, end) || null;
  }
  const noComment = trimmed.replace(/[ \t]+#.*$/, "").trim();
  return noComment || null;
};

const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: "${model}"\n  provider: "custom:888router"\n  base_url: "${baseUrl}"\n  api_key: \${OPENAI_API_KEY}\n`;

const buildProvider888Block = (model, baseUrl, extraIndentedLines = "") =>
  `  888router:\n    base_url: "${baseUrl}"\n    api_key: \${OPENAI_API_KEY}\n    default_model: "${model}"\n    session_affinity_header: "x-session-id"\n    discover_models: true\n${extraIndentedLines}`;

const parseProvider888Block = (yaml) => {
  const providersMatch = yaml.match(PROVIDERS_BLOCK_RE);
  if (!providersMatch || !providersMatch[1]) return null;
  const sub = providersMatch[1].match(PROVIDER_888_SUB_RE);
  if (!sub) return null;
  const body = sub[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]{4}${key}:[ \\t]*(.+)$`, "m"));
    return m ? unquoteYamlScalar(m[1]) : null;
  };
  const modelsMatch = body.match(
    /^[ \t]{4}models:[ \t]*(?:\r?\n((?:[ \t]{5,}.*\r?\n?|[ \t]{4}-.*\r?\n?|[ \t]*\r?\n)*)|([^\r\n]+)\r?\n?)/m
  );
  let modelsRaw = "";
  if (modelsMatch) {
    if (modelsMatch[2] && modelsMatch[2].trim()) {
      modelsRaw = `    models: ${modelsMatch[2].trim()}\n`;
    } else if (modelsMatch[1] && modelsMatch[1].trim()) {
      modelsRaw = `    models:\n${modelsMatch[1].replace(/\s*$/, "\n")}`;
    }
  }
  return {
    base_url: get("base_url"),
    default_model: get("default_model"),
    api_key: get("api_key"),
    session_affinity_header: get("session_affinity_header"),
    modelsRaw,
  };
};

const upsertProviders888Block = (yaml, model, baseUrl) => {
  const existing = parseProvider888Block(yaml);
  const block = buildProvider888Block(model, baseUrl, existing?.modelsRaw || "");
  const providersMatch = yaml.match(PROVIDERS_BLOCK_RE);
  if (!providersMatch) {
    return yaml.replace(/\s*$/, "") + (yaml.trim() ? "\n\n" : "") + `providers:\n${block}`;
  }
  const hadBlankSep = /\r?\n[ \t]*\r?\n$/.test(providersMatch[0]);
  const providersBody = providersMatch[1] || "";
  let nextBody;
  if (PROVIDER_888_SUB_RE.test(providersBody)) {
    nextBody = providersBody.replace(PROVIDER_888_SUB_RE, (m) => {
      const subHadBlank = /\r?\n[ \t]*\r?\n$/.test(m);
      return subHadBlank ? `${block}\n` : block;
    });
    if (hadBlankSep && !/\r?\n[ \t]*\r?\n$/.test(nextBody)) {
      nextBody = `${nextBody}\n`;
    }
  } else {
    const trimmedBody = providersBody.replace(/\s*$/, "");
    nextBody = `${trimmedBody}${trimmedBody ? "\n" : ""}${block}${hadBlankSep ? "\n" : ""}`;
  }
  return yaml.replace(PROVIDERS_BLOCK_RE, () => `providers:\n${nextBody}`);
};

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match || !match[1]) return null;
  const body = match[1];
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.+)$`, "m"));
    return m ? unquoteYamlScalar(m[1]) : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
    api_key: get("api_key"),
  };
};

const upsertModelBlock = (yaml, newBlock) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (match) {
    const hadBlankSep = /\r?\n[ \t]*\r?\n$/.test(match[0]);
    const replacement = hadBlankSep ? `${newBlock}\n` : newBlock;
    return yaml.replace(MODEL_BLOCK_RE, () => replacement);
  }
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// .env helpers — upsert/remove single KEY=VALUE line
const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, () => line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

const removeEnvVar = (envText, key) => {
  const re = new RegExp(`^${key}=.*\\r?\\n?`, "m");
  return envText.replace(re, "");
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getHermesConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigYaml = async () => {
  try {
    return await fs.readFile(getHermesConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readEnvFile = async () => {
  try {
    return await fs.readFile(getHermesEnvPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const removeProviders888Block = (yaml) => {
  const providersMatch = yaml.match(PROVIDERS_BLOCK_RE);
  if (!providersMatch || !providersMatch[1]) return yaml;
  if (!PROVIDER_888_SUB_RE.test(providersMatch[1])) return yaml;
  const hadBlankSep = /\r?\n[ \t]*\r?\n$/.test(providersMatch[0]);
  let nextBody = providersMatch[1].replace(PROVIDER_888_SUB_RE, "");
  if (!nextBody.trim()) {
    return yaml.replace(PROVIDERS_BLOCK_RE, "").replace(/^\n+/, "");
  }
  if (hadBlankSep && !/\r?\n[ \t]*\r?\n$/.test(nextBody)) {
    nextBody = `${nextBody.replace(/\s*$/, "\n")}\n`;
  }
  return yaml.replace(PROVIDERS_BLOCK_RE, () => `providers:\n${nextBody}`);
};

const normalizeYamlSpacing = (yaml) =>
  yaml.trim() ? yaml.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n") : "";

// Detect 888router via custom:888router provider, local/known hostnames, or providers.888router ending in /v1
const has9RouterConfig = (modelCfg, provider888Cfg) => {
  const isKnownUrl = (u) => {
    if (!u || typeof u !== "string") return false;
    return /localhost|127\.0\.0\.1|0\.0\.0\.0|888router|9router|:2012[89]\b/i.test(u.trim());
  };
  const endsWithV1 = (u) => {
    if (!u || typeof u !== "string") return false;
    return /^https?:\/\/.+\/v1\/?$/i.test(u.trim());
  };

  if (modelCfg?.provider === "custom:888router") {
    return Boolean(modelCfg?.base_url || provider888Cfg?.base_url || modelCfg?.default);
  }
  if (modelCfg?.provider === "custom" && (isKnownUrl(modelCfg?.base_url) || isKnownUrl(provider888Cfg?.base_url))) {
    return true;
  }
  if (provider888Cfg?.base_url) {
    return isKnownUrl(provider888Cfg.base_url) || endsWithV1(provider888Cfg.base_url);
  }
  return false;
};

export async function GET() {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }
    const yaml = await readConfigYaml();
    const model = parseModelBlock(yaml);
    const provider888 = parseProvider888Block(yaml);
    return NextResponse.json({
      installed: true,
      settings: {
        model,
        providers: provider888 ? { "888router": provider888 } : {},
      },
      has9Router: has9RouterConfig(model, provider888),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    const cleanBaseUrl = typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
    const cleanModel = typeof model === "string" ? model.trim() : "";
    if (!cleanBaseUrl || !cleanModel) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const dir = getHermesDir();
    await fs.mkdir(dir, { recursive: true });

    const normalizedBaseUrl = cleanBaseUrl.endsWith("/v1") ? cleanBaseUrl : `${cleanBaseUrl}/v1`;

    // Update config.yaml — configure both model: (custom:888router) and providers.888router (with session_affinity_header)
    const existingYaml = await readConfigYaml();
    let newYaml = upsertModelBlock(existingYaml, buildModelBlock(cleanModel, normalizedBaseUrl));
    newYaml = upsertProviders888Block(newYaml, cleanModel, normalizedBaseUrl);
    await fs.writeFile(getHermesConfigPath(), newYaml);

    // Update .env — upsert OPENAI_API_KEY only when caller provides one
    if (apiKey) {
      const existingEnv = await readEnvFile();
      const newEnv = upsertEnvVar(existingEnv, API_KEY_ENV, apiKey);
      await fs.writeFile(getHermesEnvPath(), newEnv);
    }

    return NextResponse.json({
      success: true,
      message: "Hermes settings applied successfully!",
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    let yaml = "";
    try {
      yaml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }
    const newYaml = normalizeYamlSpacing(removeProviders888Block(removeModelBlock(yaml)));
    await fs.writeFile(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} configuration removed` });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
