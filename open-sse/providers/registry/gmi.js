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
  // Seed from GMI developers curl + OpenClaw gmi plugin + GMI Kimi K3 blog
  // (model="moonshotai/kimi-k3"). Live catalogue via modelsFetcher after a key is saved.
  models: [
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro" },
    { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "zai-org/GLM-5.2-FP8", name: "GLM 5.2 FP8" },
  ],
  modelsFetcher: { url: "https://api.gmi-serving.com/v1/models", type: "openai" },
  passthroughModels: true,
};

export default gmiConfig;
