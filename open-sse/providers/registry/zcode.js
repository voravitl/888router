const zcodeConfig = {
  id: "zcode",
  priority: 220,
  alias: "zcode",
  uiAlias: "zcode",
  display: {
    name: "ZCode Free (GLM)",
    icon: "terminal",
    color: "#2563EB",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "Z.ai start-plan free quota (GLM 5.3 Flash) — normally exclusive to the ZCode client. Connect via the ZCode OAuth flow.",
    },
  },
  category: "oauth",
  // Live chat endpoint verified 2026-09-28: POST {anthropic base}/v1/messages
  // returns 401 (auth-gated, path exists); OpenAI-format paths returned 404,
  // so claude is the only supported upstream format — clients on other
  // formats are translated to claude by the standard transport picker.
  features: {
    usage: true,
  },
  // OAuth refresh config — consumed via PROVIDER_OAUTH by the token-refresh
  // layer (PKCE public client: no secret, the appId is embedded in the
  // public ZCode desktop bundle).
  oauth: {
    clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
    tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  },
  transport: {
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    headers: {},
  },
  transports: [
    { format: "claude", baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", auth: { combined: true, header: "Authorization", scheme: "bearer", anthropicVersion: true } },
  ],
  // Evidence-backed model set: GLM-5.3-Flash is the model the Z.ai start-plan
  // serves (the session this was reverse-engineered from runs on it). The
  // plan catalog endpoint is not publicly documented; extend after probing
  // with a live token.
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", supportedFormats: ["claude"] },
  ],
};

export default zcodeConfig;
