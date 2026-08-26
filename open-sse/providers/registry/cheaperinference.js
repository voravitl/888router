const cheaperinferenceConfig = {
  id: "cheaperinference",
  priority: 143,
  hasFree: true,
  alias: "cheaperinference",
  aliases: [
    "cheap-inf",
    "ci",
  ],
  uiAlias: "ci",
  display: {
    name: "Cheaper Inference (Zero-Cost & Free Tiers)",
    icon: "sparkles",
    color: "#8B5CF6",
    textIcon: "CI",
    website: "https://api.cheaperinference.com",
    notice: {
      text: "Cost-ranked AI gateway with zero-cost and free tier models.",
      apiKeyUrl: "https://api.cheaperinference.com",
    },
  },
  category: "aggregator",
  authType: "apikey",
  authHint: "Enter your Cheaper Inference API Key",
  transport: {
    baseUrl: "https://api.cheaperinference.com/v1",
    format: "openai",
    authType: "apikey",
  },
  models: [
    { id: "claude-opus-4-8-fast", name: "Claude Opus 4.8 Fast (Free Tier)", toolCalling: true },
    { id: "claude-fable-5", name: "Claude Fable 5", toolCalling: true },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", toolCalling: true },
    { id: "gpt-5", name: "GPT-5 (via CheaperInference)", toolCalling: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", toolCalling: true },
    { id: "deepseek-v3", name: "DeepSeek V3", toolCalling: true },
    { id: "llama-3.3-70b", name: "Llama 3.3 70B", toolCalling: true },
  ],
};

export default cheaperinferenceConfig;
