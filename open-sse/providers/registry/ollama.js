const ollamaConfig = {
  id: "ollama",
  priority: 30,
  hasFree: true,
  alias: "ollama",
  display: {
    name: "Ollama Cloud",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
    notice: {
      text: "Per-token pricing model. Pro ($20/mo = $60 credits) · Max ($100/mo = $300 credits) · Team ($500/mo = $1,000 credits) · Free tier pay-as-you-go.",
      apiKeyUrl: "https://ollama.com/settings/keys",
    },
  },
  category: "freeTier",
  transport: {
    baseUrl: "https://ollama.com/api/chat",
    validateUrl: "https://ollama.com/api/tags",
    format: "ollama",
  },
  models: [
    { id: "gpt-oss:120b", name: "GPT OSS 120B" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "glm-5", name: "GLM 5" },
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "glm-4.7-flash", name: "GLM 4.7 Flash" },
    { id: "qwen3.5", name: "Qwen3.5" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
  serviceKinds: ["llm", "webFetch"],
  fetchConfig: {
    baseUrl: "https://ollama.com/api/web_fetch",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    formats: ["markdown"],
    maxCharacters: 200000,
    timeoutMs: 30000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};

export default ollamaConfig;
