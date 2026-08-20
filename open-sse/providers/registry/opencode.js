const opencodeConfig = {
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
  authHint: "OpenCode Free (Zen) mode - public access or OpenCode Go API key.",
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  models: [
    { id: "mimo-v2.5-free", name: "MiMo V2.5 (Free)" },
    { id: "hy3-free", name: "HY3 (Free)" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)" },
    { id: "x-preview-f-free", name: "X Preview F (Free)" },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 (Free)" },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor (Free)" },
    { id: "big-pickle", name: "Big Pickle (Free)" },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash (Free)" },
  ],
};

export default opencodeConfig;
