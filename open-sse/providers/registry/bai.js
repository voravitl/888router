const baiConfig = {
  id: "bai",
  priority: 69,
  alias: "bai",
  aliases: [
    "b-ai",
    "b.ai",
  ],
  uiAlias: "bai",
  display: {
    name: "B.AI",
    icon: "hub",
    color: "#9CA3AF",
    textIcon: "B.",
    website: "https://b.ai/",
    notice: {
      text: "OpenAI-compatible gateway at api.b.ai (Bearer or x-api-key). Limited-time 0-credit promos (DeepSeek V4 Flash, Hy3, MiMo) are not a documented permanent $0 SKU — they return to standard pricing after the offer. Top-up/credits otherwise. GET /v1/models requires a key.",
      apiKeyUrl: "https://chat.b.ai/",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  thinkingConfig: {
    options: ["auto", "none", "low", "medium", "high"],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
    thinkingFormat: "openai",
  },
  // Documented seed ids from docs.b.ai (OpenClaw / Claude Code / models pages).
  // Full catalogue is fetched via modelsFetcher after a key; other ids via passthroughModels.
  // Do not invent mimo-v2.5 — docs never backtick that API id.
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
    { id: "hy3", name: "Hy3" },
    { id: "gpt-5.2", name: "GPT-5.2" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "glm-5.2", name: "GLM 5.2" },
  ],
  modelsFetcher: { url: "https://api.b.ai/v1/models", type: "openai" },
  passthroughModels: true,
};

export default baiConfig;
