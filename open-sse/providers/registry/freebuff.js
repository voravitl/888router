const freebuffConfig = {
  id: "freebuff",
  priority: 144,
  hasFree: true,
  alias: "freebuff",
  aliases: [
    "codebuff",
    "fb",
  ],
  uiAlias: "fb",
  display: {
    name: "FreeBuff (Developer Free Gateway)",
    icon: "codebuff",
    color: "#EC4899",
    textIcon: "FB",
    website: "https://www.codebuff.com",
    notice: {
      text: "Free developer gateway providing high-performance model access.",
      apiKeyUrl: "https://www.codebuff.com",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authHint: "Enter your FreeBuff / Codebuff API Key",
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1",
    format: "openai",
    authType: "apikey",
  },
  models: [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (FreeBuff)", toolCalling: true },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna (FreeBuff)", toolCalling: true },
    { id: "minimax/minimax-m3", name: "MiniMax M3 (FreeBuff)", toolCalling: true },
    { id: "mimo/mimo-v2.5", name: "MiMo v2.5 (FreeBuff)", toolCalling: true },
    { id: "z-ai/glm-5.2", name: "GLM 5.2 (FreeBuff)", toolCalling: true },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco (FreeBuff)", toolCalling: true },
  ],
};

export default freebuffConfig;
