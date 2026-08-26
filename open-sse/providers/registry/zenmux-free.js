const zenmux_freeConfig = {
  id: "zenmux-free",
  priority: 145,
  hasFree: true,
  alias: "zenmux-free",
  aliases: [
    "zm-free",
    "zmf",
  ],
  uiAlias: "zmf",
  display: {
    name: "ZenMux Free (Cookie / Free Tier)",
    icon: "zenmux",
    color: "#6366F1",
    textIcon: "ZMF",
    website: "https://zenmux.ai",
    notice: {
      text: "Free session-cookie gateway providing 5 Flows per 5h renewable free access.",
      apiKeyUrl: "https://zenmux.ai",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your ZenMux Cookie header or ctoken from zenmux.ai",
  transport: {
    baseUrl: "https://zenmux.ai/api/anthropic/v1/messages",
    format: "claude",
    authType: "cookie",
  },
  models: [
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3.2 Free", toolCalling: true },
    { id: "deepseek/deepseek-reasoner", name: "DeepSeek V3.2 Thinking Free", toolCalling: true },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro Free", toolCalling: true },
    { id: "z-ai/glm-4.7-flash-free", name: "GLM 4.7 Flash Free", toolCalling: true },
    { id: "stepfun/step-3.5-flash-free", name: "Step 3.5 Flash Free", toolCalling: true },
    { id: "inclusionai/ling-1t", name: "Ling 1T Free", toolCalling: true },
  ],
};

export default zenmux_freeConfig;
