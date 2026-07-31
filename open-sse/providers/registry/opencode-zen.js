export default {
  id: "opencode-zen",
  priority: 211,
  noAuth: true,
  hasFree: true,
  alias: "opencode-zen",
  aliases: ["oc-zen", "zen"],
  uiAlias: "oc-zen",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Zen Free: Public access to GLM, Kimi, DeepSeek, MiMo, MiniMax, Qwen models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  category: "free",
  authModes: ["noauth"],
  authHint: "OpenCode Zen Free mode - public access.",
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  models: [
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)" },
    { id: "mimo-v2.5-free", name: "MiMo V2.5 (Free)" },
    { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash (Free)" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)" },
    { id: "north-mini-code-free", name: "North Mini Code (Free)" },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 (Free)" },
  ],
};
