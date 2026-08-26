const agentrouterConfig = {
  id: "agentrouter",
  priority: 15,
  hasFree: true,
  alias: "agentrouter",
  display: {
    name: "AgentRouter",
    icon: "agentrouter",
    color: "#10B981",
    textIcon: "AR",
    website: "https://agentrouter.org",
    notice: {
      text: "Get $200 free credits at https://agentrouter.org/register — no credit card required.",
      apiKeyUrl: "https://agentrouter.org/register",
    },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://agentrouter.org/v1/messages",
    authType: "apikey",
    authHeader: "x-api-key",
    format: "claude",
    alternateFormats: [
      {
        format: "openai",
        baseUrl: "https://agentrouter.org/v1/chat/completions",
        authHeader: "bearer",
        label: "OpenAI-compatible (Codex)",
      },
      {
        format: "openai-responses",
        baseUrl: "https://agentrouter.org/v1/responses",
        authHeader: "bearer",
        label: "OpenAI Responses (Codex)",
      },
    ],
  },
  models: [
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "deepseek-v3", name: "DeepSeek V3" },
    { id: "deepseek-r1", name: "DeepSeek R1" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
};

export default agentrouterConfig;
