const tokenharborConfig = {
  id: "tokenharbor",
  priority: 71,
  alias: "tokenharbor",
  aliases: [
    "th",
    "token-harbor",
  ],
  uiAlias: "tokenharbor",
  display: {
    name: "TokenHarbor",
    icon: "hub",
    color: "#0D9488",
    textIcon: "TH",
    website: "https://tokenharbor.ai/",
    notice: {
      text: "OpenAI-compatible gateway at tokenharbor.ai (Bearer API key). 3 free models (DeepSeek V4.1/V4 Flash, MiMo V2.5). GET /v1/models requires a key.",
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
  },
  // Seed snapshot from the public /models page (verified 2026-09-11:
  // 18 paid + 3 free surfaces, priceIn/priceOut/isFree flags; evidence:
  // /tmp/th-catalog.json + /tmp/th-freerows.json captured from the page).
  // Quota semantics are UNKNOWN (page shows price 0/0 but no daily cap,
  // rate limit, or trial terms): free rows use recurring-daily with 0
  // budgets, matching the existing zero-budget convention (e.g.
  // chatgpt-web-free rows) — 0 means "unknown, route but fail-open on
  // 429/402", never a guaranteed allowance. Quota exhaustion is handled
  // at request time by the combo executor's fallback (429/402 → next
  // model), same as every other keyed gateway (bai, tokenrouter).
  // Full catalogue is fetched via modelsFetcher after a key; other ids via passthroughModels.
  models: [
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "qwen3.8-27b", name: "Qwen3.8 27B" },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "mimo-v2.5", name: "MiMo V2.5" },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "deepseek-v4-flash:free", name: "DeepSeek V4 Flash (Free)" },
    { id: "mimo-v2.5:free", name: "MiMo V2.5 (Free)" },
  ],
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  passthroughModels: true,
};

export default tokenharborConfig;
