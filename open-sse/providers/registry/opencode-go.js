const opencode_goConfig = {
  id: "opencode-go",
  priority: 210,
  alias: "opencode-go",
  aliases: [
    "ocg",
  ],
  uiAlias: "ocg",
  display: {
    name: "OpenCode Go",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Go subscription: $5/mo (then  0/mo). Access to Kimi, GLM, Qwen, MiMo, MiniMax models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  category: "apikey",
  // Live catalog: GET https://opencode.ai/zen/go/v1/models (Bearer public)
  // returns the current paid-catalog ids. /v1/models + dashboard use this via
  // a dedicated opencode-go resolver (not the generic openai one — that one
  // sends the user's private API key and has no public-credential concept).
  // Static `models` below is the offline fallback AND the supportedFormats
  // source of truth: live ids without a seed entry route openai-only.
  modelsFetcher: { url: "https://opencode.ai/zen/go/v1/models", type: "opencode-go" },
  passthroughModels: true,
  transport: {
    baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    headers: {},
  },
  // Multi-endpoint: pick the transport matching the client sourceFormat to skip
  // translation. Guarded per-model by `supportedFormats` (see chatCore) because
  // opencode-go models differ in endpoint support.
  transports: [
    { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
    { format: "claude", baseUrl: "https://opencode.ai/zen/go/v1/messages", auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true } },
    { format: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1/responses", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  ],
  // Static catalog: the supportedFormats source of truth AND the offline
  // fallback. Live catalog (modelsFetcher GET /zen/go/v1/models, served via
  // the dedicated opencode-go resolver in src/app/api/v1/models/route.js)
  // adds newly-released upstream ids to /v1/models + dashboard WITHOUT
  // registry edits — but live ids carry no supportedFormats, so they route
  // openai-only by the chatCore guard. Full entries below (not one-per-family)
  // so claude/responses-capable models keep their transports offline too.
  // passthroughModels stays true (pre-existing contract: forward client id
  // untouched); the live catalog is discovery, not an allowlist.
  models: [
    { id: "glm-5.2", name: "GLM 5.2", supportedFormats: ["openai"] },
    { id: "glm-5.1", name: "GLM 5.1", supportedFormats: ["openai"] },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", supportedFormats: ["openai"] },
    { id: "kimi-k2.6", name: "Kimi K2.6", supportedFormats: ["openai"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "mimo-v2.5", name: "MiMo V2.5", supportedFormats: ["openai"] },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", supportedFormats: ["openai"] },
    { id: "minimax-m3", name: "MiniMax M3", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.7", name: "MiniMax M2.7", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.5", name: "MiniMax M2.5", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", supportedFormats: ["openai", "claude"] },
  ],
};

export default opencode_goConfig;
