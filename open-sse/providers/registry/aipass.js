const aipassConfig = {
  id: "aipass",
  priority: 142,
  hasFree: true,
  noAuth: true,
  alias: "aipass",
  aliases: [
    "aipass-th",
    "aipass-bridge",
    "ap",
  ],
  uiAlias: "ap",
  display: {
    name: "AiPASS TH (Thai AI Passport Free)",
    icon: "passkey",
    color: "#0052CC",
    textIcon: "AiPASS",
    website: "https://de.aipass.net/chat",
    notice: {
      text: "Free access to 30+ pro AI models (Claude Sonnet 5, Gemini 3.1 Flash Lite, GPT-Image-2) for Thai citizens via the AiPASS Chrome Extension.",
      apiKeyUrl: "https://de.aipass.net/chat",
    },
  },
  category: "freeTier",
  authType: "none",
  authHint: "Zero credentials stored. Connects via AiPASS Chrome Extension to your logged-in de.aipass.net tab.",
  transport: {
    // Extension SSE hub inside 888router (/ext/events) — not an HTTP base URL.
    // A 127.0.0.1:8787 default here collided with the headroom container port.
    baseUrl: "bridge://aipass-hub",
    format: "openai",
    authType: "none",
  },
  models: [
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite (AiPASS Free)", thinking: false },
    { id: "claude-sonnet-5@default", name: "Claude Sonnet 5 (AiPASS)", thinking: true },
    { id: "claude-opus-5@default", name: "Claude Opus 5 (AiPASS)", thinking: true },
    { id: "gpt-image-2", name: "GPT-Image-2 (AiPASS)", kind: "image" },
    { id: "gemini-3-pro-image", name: "Nano Banana Pro (AiPASS)", kind: "image" },
    { id: "veo-3.1-fast-generate-001", name: "Veo 3.1 Fast (AiPASS)", kind: "video" },
    { id: "lyria-3-pro-preview", name: "Lyria 3 Pro (AiPASS)", kind: "music" },
    { id: "sonar-deep-research", name: "Sonar Deep Research (AiPASS)" },
    { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro (AiPASS)", thinking: true },
  ],
};

export default aipassConfig;
