#!/usr/bin/env node
/**
 * Sync OpenCode catalog from live API to static registries
 * Usage: node scripts/sync-opencode-catalog.mjs [tier]
 *   tier: "go" | "free" | "all" (default: all)
 *
 * Fetches from live catalogs and updates:
 *   - open-sse/providers/registry/opencode-go.js (paid tier)
 *   - open-sse/providers/registry/opencode.js (free tier)
 */

import fs from 'fs';

const CATALOGS = {
  go: {
    url: 'https://opencode.ai/zen/go/v1/models',
    registryPath: 'open-sse/providers/registry/opencode-go.js',
    providerId: 'opencode-go',
    displayName: 'OpenCode Go',
    category: 'pro',
    noAuth: false,
  },
  free: {
    url: 'https://opencode.ai/zen/v1/models',
    registryPath: 'open-sse/providers/registry/opencode.js',
    providerId: 'opencode',
    displayName: 'OpenCode Zen',
    category: 'free',
    noAuth: true,
  },
};

// Format mapping from docs endpoint table
const FORMAT_MAP = {
  'grok-': 'openai-responses',
  'gpt-': 'openai-responses',
  'muse-spark': 'openai-responses',
  'claude-haiku': 'claude',
  'minimax-m3': 'claude',
  'qwen3.8-max': 'claude',
  'qwen3.8-flash': 'claude',
  'qwen3.7-plus': 'claude',
};

function getSupportedFormats(id) {
  for (const [prefix, fmt] of Object.entries(FORMAT_MAP)) {
    if (id.startsWith(prefix)) return [fmt];
  }
  return ['openai'];
}

async function fetchLiveCatalog(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Authorization': 'Bearer public',
    }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.json();
  return data.data || data;
}

function generateGoRegistry(models) {
  const entries = models.map(m => {
    const id = m.id;
    const name = m.name || id;
    const formats = getSupportedFormats(id);
    return `    { id: "${id}", name: "${name}", supportedFormats: ${JSON.stringify(formats)} },`;
  });

  return `const opencode_goConfig = {
  id: "opencode-go",
  priority: 210,
  hasFree: true,
  alias: "ocg",
  aliases: ["ocg", "opencode-go"],
  uiAlias: "ocg",
  display: {
    name: "OpenCode Go",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OCG",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Go: Paid tier with access to all models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  noAuth: false,
  category: "pro",
  authModes: ["apikey"],
  authHint: "OpenCode Go paid tier - requires API key from console.",
  transport: {
    baseUrl: "https://opencode.ai",
    forceStream: false,
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/go/v1/models", type: "opencode-go" },
  passthroughModels: true,
  models: [
${entries.join('\n')}
  ],
};

export default opencode_goConfig;
`;
}

function generateFreeRegistry(models) {
  const entries = models.map(m => {
    const id = m.id;
    const name = m.name || id;
    return `    { id: "${id}", name: "${name}" },`;
  });

  return `const opencodeConfig = {
  id: "opencode",
  priority: 210,
  hasFree: true,
  alias: "oc",
  aliases: ["oc", "opencode", "opencode-zen", "zen"],
  uiAlias: "oc",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Zen Free: Access to GLM, Kimi, DeepSeek, MiMo, MiniMax, Qwen free models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  noAuth: true,
  category: "free",
  authModes: ["noauth", "apikey"],
  authHint: "OpenCode Zen mode - public access or Zen API key (key required for free models via third-party clients).",
  transport: {
    baseUrl: "https://opencode.ai",
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  models: [
${entries.join('\n')}
  ],
};

export default opencodeConfig;
`;
}

async function syncTier(tier) {
  const config = CATALOGS[tier];
  console.log(`\\n=== Syncing ${config.displayName} (${tier}) ===`);
  console.log(`Fetching from ${config.url}...`);
  const models = await fetchLiveCatalog(config.url);
  console.log(`Found ${models.length} models`);

  const registry = config.providerId === "opencode-go" ? generateGoRegistry(models) : generateFreeRegistry(models);
  fs.writeFileSync(config.registryPath, registry);
  console.log(`Updated ${config.registryPath}`);

  const formats = {};
  for (const m of models) {
    const fmt = getSupportedFormats(m.id)[0];
    formats[fmt] = (formats[fmt] || 0) + 1;
  }
  console.log('Format distribution:', formats);
  return models.length;
}

async function main() {
  const tiers = process.argv.slice(2);
  const targets = tiers.length > 0 ? (tiers.includes("all") ? Object.keys(CATALOGS) : tiers) : Object.keys(CATALOGS);
  let total = 0;
  for (const tier of targets) {
    if (!CATALOGS[tier]) {
      console.error(`Unknown tier: ${tier}`);
      continue;
    }
    total += await syncTier(tier);
  }
  console.log(`\\nTotal models synced: ${total}`);
  console.log('Done!');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
