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
    { id: "mimo-v2.5-free", name: "mimo-v2.5-free" },
    { id: "hy3-free", name: "hy3-free" },
    { id: "ling-3.0-flash-fin-free", name: "ling-3.0-flash-fin-free" },
    { id: "nemotron-3-ultra-free", name: "nemotron-3-ultra-free" },
    { id: "nemotron-3.5-lightning-free", name: "nemotron-3.5-lightning-free" },
    { id: "x-preview-f-free", name: "Ox Alpha Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "laguna-s-2.1-free", name: "laguna-s-2.1-free" },
    { id: "muse-spark-1.2-contributor-free", name: "muse-spark-1.2-contributor-free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "muse-spark-1.3-contributor-free", targetFormat: "openai-responses" },
    { id: "big-pickle", name: "big-pickle" },
    { id: "deepseek-v4-flash-free", name: "deepseek-v4-flash-free" },
  ],
};

export default opencodeConfig;
