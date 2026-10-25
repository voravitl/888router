import { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

const antigravityConfig = {
  id: "antigravity",
  priority: 20,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image"],
  transport: {
    baseUrls: [
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
    ],
    format: "antigravity",
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": {
        attempts: 6,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
    },
    usage: {
      quotaApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      quotaSummaryApiUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
  models: [
    // gemini-4-argon-high was removed 2026-10-25: the entry was ported from
    // upstream 9router on 2026-10-17 BEFORE Google rolled Argon out, and the
    // rollout still has not reached this account — the live
    // fetchAvailableModels (200 OK, verified 2026-10-25) lists 26 model keys
    // with no argon / no gemini-4 id, while every other antigravity model
    // answered the same day. The gateway never served it once (0/5, all 404
    // "Requested entity was not found"), and advertising it put the combo
    // picker one click away from a guaranteed 404. When Google's rollout
    // lands, the id returns through the dynamic model sync
    // (fetchAvailableModels → parseGeminiCliModels) and the quota parser
    // already accepts the bare argon key (services/usage/google.js); re-add
    // a static entry only if the thinking-level mapping needs the explicit
    // upstreamModelId "gemini-4-argon-high(high)".
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    // The 3.6 / 3.7 flash tiers, the 3.5 flash tiers, the 3.1 pro tiers and
    // the 3-flash agent were removed 2026-10-22: Google retired the models and
    // every one of them answers 404 "Requested entity was not found" (verified
    // live, each read in full — see tests/unit/antigravity-dead-models.test.js).
    // They were still being advertised, which sent clients to models that
    // cannot answer. Note that removing them from the registry is NOT enough on
    // its own: Google's own live model list still carries the "-tiered" base
    // ids, and the catalogue expands those into -high/-medium/-low — so those
    // ids are hidden through the disabled-models list as well.
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", thinking: true },
    { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", thinking: true },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", thinking: true },
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", thinking: true },
    { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", thinking: true },
    { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", thinking: true },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", thinking: false },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  features: {
    usage: true,
  },
};

export default antigravityConfig;
