const felo_webConfig = {
  id: "felo-web",
  priority: 142,
  hasFree: true,
  alias: "felo-web",
  aliases: [
    "felo",
    "felo-ai",
  ],
  uiAlias: "felo",
  display: {
    name: "Felo OpenAPI (Search-grounded LLM)",
    icon: "felo",
    color: "#3B82F6",
    textIcon: "FELO",
    website: "https://felo.ai",
    notice: {
      text: "Felo API Platform — search-grounded chat via openapi.felo.ai. Requires a Felo API key (free tier available).",
      apiKeyUrl: "https://felo.ai/settings/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  authHint: "Enter your Felo OpenAPI key (https://felo.ai/settings/api-keys)",
  transport: {
    // LLM API (OpenAI-compatible). The old keyless /api-proxy/main/search/threads
    // endpoint requires a turnstile session token and a query-shaped body — not
    // reachable from DefaultExecutor's chat flow. Evidence: openapi.felo.ai/docs
    // (POST /api/v1/chat/completions), live probe returns 401 UNAUTHORIZED.
    baseUrl: "https://openapi.felo.ai/api/v1/chat/completions",
    format: "openai",
    authType: "apikey",
  },
  models: [
    // IDs from openapi.felo.ai/docs/api-reference/llm pricing table
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextLength: 1050000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextLength: 1050000 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000, toolCalling: true },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200000, toolCalling: true },
    { id: "grok-4.5", name: "Grok 4.5", contextLength: 500000, toolCalling: true },
  ],
};

export default felo_webConfig;
