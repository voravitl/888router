const gmiConfig = {
  id: "gmi",
  priority: 68,
  alias: "gmi",
  aliases: [
    "gmi-cloud",
    "gmicloud",
  ],
  uiAlias: "gmi",
  display: {
    name: "GMI Cloud",
    icon: "cloud",
    color: "#0B5FFF",
    textIcon: "GMI",
    website: "https://www.gmicloud.ai/en/developers",
    notice: {
      text: "GMI Cloud serverless inference: OpenAI-compatible API at api.gmi-serving.com. Includes moonshotai/kimi-k3. Create a key in the console; rates are on each Model Hub card (not a documented $0 SKU).",
      apiKeyUrl: "https://console.gmicloud.ai/",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.gmi-serving.com/v1/chat/completions",
    validateUrl: "https://api.gmi-serving.com/v1/models",
    thinkingFormat: "openai",
  },
  // Seed only ids shown in official GMI curls. Live catalogue via modelsFetcher
  // after a key is saved (passthroughModels covers the rest of /v1/models).
  // kimi-k3: https://www.gmicloud.ai/en/blog/kimi-k3-open-weights-are-here-the-benchmark-phase-starts-now
  // DeepSeek-V4-Pro: https://www.gmicloud.ai/en/developers
  models: [
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
  ],
  modelsFetcher: { url: "https://api.gmi-serving.com/v1/models", type: "openai" },
  passthroughModels: true,
};

export default gmiConfig;
