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
    name: "Felo AI Search (Keyless / Permanent Free)",
    icon: "felo",
    color: "#3B82F6",
    textIcon: "FELO",
    website: "https://felo.ai",
    notice: {
      text: "Keyless AI Web Search & Synthesis provided by Felo.ai. No API Key required.",
      apiKeyUrl: "https://felo.ai",
    },
  },
  category: "freeTier",
  authType: "none",
  authHint: "No API Key required. Click Connect to enable instant free access.",
  transport: {
    baseUrl: "https://felo.ai/api-proxy/main/search/threads",
    format: "openai",
    authType: "none",
  },
  models: [
    { id: "felo-chat", name: "Felo Chat (Free)", toolCalling: false },
    { id: "felo-search", name: "Felo Search (Web Grounded)", toolCalling: false },
    { id: "felo-scholar", name: "Felo Scholar (Academic)", toolCalling: false },
    { id: "felo-social", name: "Felo Social (Social Media)", toolCalling: false },
    { id: "felo-document", name: "Felo Document (Doc Search)", toolCalling: false },
  ],
};

export default felo_webConfig;
