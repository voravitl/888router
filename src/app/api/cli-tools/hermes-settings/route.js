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
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const PROVIDERS_BLOCK_RE = /^providers:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

const buildModelBlock = (model, baseUrl) =>
  `model:\n  default: "${model}"\n  provider: "custom:888router"\n  base_url: "${baseUrl}"\n  api_key: \${OPENAI_API_KEY}\n`;

const buildProvider888Block = (model, baseUrl, extraIndentedLines = "") =>
  `  888router:\n    base_url: "${baseUrl}"\n    api_key: \${OPENAI_API_KEY}\n    default_model: "${model}"\n    session_affinity_header: "x-session-id"\n    discover_models: true\n${extraIndentedLines}`;

const parseProvider888Block = (yaml) => {
  const providersMatch = yaml.match(PROVIDERS_BLOCK_RE);
  if (!providersMatch) return null;
  const sub = providersMatch[1].match(/^[ \t]{2}888router:[ \t]*\r?\n((?:[ \t]{4,}.*\r?\n?|[ \t]*\r?\n)*)/m);
  if (!sub) return null;
  const body = sub[1];
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]{4}${key}:[ \\t]*(.+)$`, "m"));
    if (!m) return null;
    const val = m[1].trim().replace(/^["']|["']$/g, "");
    return val;
  };
  const modelsMatch = body.match(/^[ \t]{4}models:[ \t]*\r?\n((?:[ \t]{6,}.*\r?\n?|[ \t]*\r?\n)*)/m);
  return {
    base_url: get("base_url"),
    default_model: get("default_model"),
    api_key: get("api_key"),
    session_affinity_header: get("session_affinity_header"),
    modelsRaw: modelsMatch ? `    models:\n${modelsMatch[1].replace(/\s*$/, "\n")}` : "",
  };
};

const upsertProviders888Block = (yaml, model, baseUrl) => {
  const existing = parseProvider888Block(yaml);
  const block = buildProvider888Block(model, baseUrl, existing?.modelsRaw || "");
  const providersMatch = yaml.match(PROVIDERS_BLOCK_RE);
  if (!providersMatch) {
    return yaml.replace(/\s*$/, "") + (yaml.trim() ? "\n\n" : "") + `providers:\n${block}`;
  }
  const providersBody = providersMatch[1];
  const subRe = /^[ \t]{2}888router:[ \t]*\r?\n((?:[ \t]{4,}.*\r?\n?|[ \t]*\r?\n)*)/m;
  const nextBody = subRe.test(providersBody)
    ? providersBody.replace(subRe, block)
    : `${providersBody.replace(/\s*$/, "")}${providersBody.trim() ? "\n" : ""}${block}`;
  return yaml.replace(PROVIDERS_BLOCK_RE, `providers:\n${nextBody}`);
};

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
    api_key: get("api_key"),
  };
};

const upsertModelBlock = (yaml, newBlock) => {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// .env helpers — upsert/remove single KEY=VALUE line
const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
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
  if (!providersMatch) return yaml;
  const subRe = /^[ \t]{2}888router:[ \t]*\r?\n((?:[ \t]{4,}.*\r?\n?|[ \t]*\r?\n)*)/m;
  const nextBody = providersMatch[1].replace(subRe, "");
  if (!nextBody.trim()) {
    return yaml.replace(PROVIDERS_BLOCK_RE, "").replace(/^\n+/, "");
  }
  return yaml.replace(PROVIDERS_BLOCK_RE, `providers:\n${nextBody}`);
};

// Detect 888router by base_url containing localhost/127.0.0.1 or providers.888router
const has9RouterConfig = (modelCfg, provider888Cfg) => {
  const isLocal = (u) => Boolean(u && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(u));
  if ((modelCfg?.provider === "custom" || modelCfg?.provider === "custom:888router") && isLocal(modelCfg?.base_url)) {
    return true;
  }
  return isLocal(provider888Cfg?.base_url);
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
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const dir = getHermesDir();
    await fs.mkdir(dir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    // Update config.yaml — configure both model: (custom:888router) and providers.888router (with session_affinity_header)
    const existingYaml = await readConfigYaml();
    let newYaml = upsertModelBlock(existingYaml, buildModelBlock(model, normalizedBaseUrl));
    newYaml = upsertProviders888Block(newYaml, model, normalizedBaseUrl);
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
    const newYaml = removeProviders888Block(removeModelBlock(yaml));
    await fs.writeFile(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} configuration removed` });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
