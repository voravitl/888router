const nousresearchConfig = {
  id: "nousresearch",
  priority: 65,
  alias: "nous",
  aliases: [
    "nous-portal",
    "nousportal",
  ],
  uiAlias: "nous",
  display: {
    name: "Nous Research",
    icon: "psychology",
    color: "#7000FF",
    textIcon: "NR",
    website: "https://portal.nousresearch.com",
    notice: {
      text: "Nous Portal: OpenAI-compatible gateway at inference-api.nousresearch.com. 300+ models (Hermes 4, Claude, GPT, Gemini, DeepSeek, …) billed to your Nous subscription. Bearer API key or Portal JWT.",
      apiKeyUrl: "https://portal.nousresearch.com",
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
    baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
    validateUrl: "https://inference-api.nousresearch.com/v1/models",
    thinkingFormat: "openai",
  },
  // Featured seed from live GET /v1/models (2026-08-23, 373 entries).
  // Full catalogue is fetched via modelsFetcher; other ids via passthroughModels.
  models: [
    { id: "nousresearch/hermes-4-405b", name: "Hermes 4 405B" },
    { id: "nousresearch/hermes-4-70b", name: "Hermes 4 70B" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "openai/gpt-5.5", name: "GPT-5.5" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
    { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
    { id: "voyageai/voyage-4", name: "Voyage 4", kind: "embedding" },
    { id: "google/gemini-embedding-2", name: "Gemini Embedding 2", kind: "embedding" },
  ],
  serviceKinds: ["llm", "embedding"],
  embeddingConfig: {
    baseUrl: "https://inference-api.nousresearch.com/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
  },
  modelsFetcher: { url: "https://inference-api.nousresearch.com/v1/models", type: "openai" },
  passthroughModels: true,
};

export default nousresearchConfig;
