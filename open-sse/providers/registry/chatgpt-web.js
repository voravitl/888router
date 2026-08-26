const chatgpt_webConfig = {
  id: "chatgpt-web",
  priority: 140,
  hasFree: true,
  alias: "chatgpt-web",
  aliases: [
    "cgpt-web",
    "cw",
  ],
  uiAlias: "cw",
  display: {
    name: "ChatGPT Web (Cookie / Free & Plus)",
    icon: "openai",
    color: "#10A37F",
    textIcon: "CW",
    website: "https://chatgpt.com",
    notice: {
      text: "Use your ChatGPT session cookie from chatgpt.com (DevTools -> Application -> Cookies -> __Secure-next-auth.session-token).",
      apiKeyUrl: "https://chatgpt.com",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your __Secure-next-auth.session-token or full Cookie header from chatgpt.com",
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/conversation",
    format: "chatgpt-web",
    authType: "cookie",
  },
  models: [
    { id: "gpt-5.6-luna-free", name: "GPT-5.6 Luna (Free)", toolCalling: false },
    { id: "gpt-5.6-luna-free-thinking", name: "GPT-5.6 Luna (Free, Think)", toolCalling: false },
    { id: "gpt-5.6-sol-pro", name: "GPT-5.6 Sol (Pro)", toolCalling: false },
    { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol (High)", toolCalling: false },
    { id: "gpt-5.6-sol-instant", name: "GPT-5.6 Sol (Instant)", toolCalling: false },
    { id: "gpt-5.5-pro", name: "GPT-5.5 (Pro)", toolCalling: false },
    { id: "gpt-5.5-high", name: "GPT-5.5 (High)", toolCalling: false },
    { id: "gpt-5.5-instant", name: "GPT-5.5 (Instant)", toolCalling: false },
    { id: "gpt-4o", name: "GPT-4o (Web)", toolCalling: false },
    { id: "gpt-4o-mini", name: "GPT-4o Mini (Web)", toolCalling: false },
  ],
  passthroughModels: true,
};

export default chatgpt_webConfig;
