const duckduckgo_webConfig = {
  id: "duckduckgo-web",
  priority: 141,
  hasFree: true,
  alias: "duckduckgo-web",
  aliases: [
    "ddg-web",
    "ddgw",
    "duckchat",
  ],
  uiAlias: "ddg",
  display: {
    name: "DuckDuckGo AI (Keyless / Permanent Free)",
    icon: "duckduckgo",
    color: "#DE5833",
    textIcon: "DDG",
    website: "https://duckduckgo.com/chat",
    notice: {
      text: "Keyless 100% Free AI Chat provided by DuckDuckGo. No API Key or cookie required.",
      apiKeyUrl: "https://duckduckgo.com/chat",
    },
  },
  category: "freeTier",
  authType: "none",
  authHint: "No API Key required. Click Connect to enable instant free access.",
  transport: {
    baseUrl: "https://duckduckgo.com/duckchat/v1/chat",
    format: "openai",
    authType: "none",
  },
  models: [
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (DuckDuckGo Free)", toolCalling: false },
    { id: "gpt-5.4-nano", name: "GPT-5.4 Nano (DuckDuckGo Free)", toolCalling: false },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (DuckDuckGo Free)", toolCalling: false },
    { id: "mistral-small-2603", name: "Mistral Small 4 (DuckDuckGo Free)", toolCalling: false },
    { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B (DuckDuckGo Free)", toolCalling: false },
    { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B (DuckDuckGo Free)", toolCalling: false },
  ],
};

export default duckduckgo_webConfig;
