const opencodeConfig = {
  id: "opencode",
  priority: 210,
  hasFree: true,
  alias: "oc",
  aliases: ["oc", "opencode", "opencode-zen", "zen"],
  uiAlias: "oc",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Zen Free: Access to GLM, Kimi, DeepSeek, MiMo, MiniMax, Qwen free models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  noAuth: true,
  category: "free",
  authModes: ["noauth", "apikey"],
  authHint: "OpenCode Zen mode - public access or Zen API key (key required for free models via third-party clients).",
  transport: {
    baseUrl: "https://opencode.ai",
    // Upstream free-tier gate rejects stream:false with 403 FreeTierError
    // (verified live). Force SSE upstream; chatCore converts back to JSON
    // for non-streaming clients via the existing forced-SSE path.
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
  // Free catalogue. Every id here was verified to SERVE against the live
  // gateway on 2026-10-21 (two probes each, identical results).
  //
  // Ids that upstream RETIRED are removed: they answer HTTP 410
  // ModelDeprecated, and while they were listed here /v1/models advertised
  // them to every client — which then picked a dead model and failed.
  //   mimo-v2.5-free, muse-spark-1.2-contributor-free,
  //   muse-spark-1.3-contributor-free, space-bunny-free
  //
  // Ids upstream still lists but cannot serve are removed too (HTTP 400
  // "Model is unavailable" / ModelProtocolUnsupported on every endpoint):
  //   deepseek-v4-flash-free, ling-3.0-flash-fin-free, jev-1.13-free
  //
  // `nemotron-3-ultra-free` is NOT in the upstream /v1/models list but still
  // answers 200 — "absent from the list" is not evidence of death, so it stays.
  // The paid tier (registry/opencode-go.js) is a DIFFERENT upstream and keeps
  // its own catalogue; the two must not be pruned together.
  models: [
    { id: "nemotron-3-ultra-free", name: "nemotron-3-ultra-free" },
    { id: "nemotron-3.5-lightning-free", name: "nemotron-3.5-lightning-free" },
    { id: "nemotron-3.5-super-vl-free", name: "nemotron-3.5-super-vl-free" },
    { id: "mimo-v2.6-flash-free", name: "mimo-v2.6-flash-free" },
    { id: "beam-free", name: "beam-free" },
    { id: "deepseek-v4.1-flash-free", name: "deepseek-v4.1-flash-free" },
    { id: "glm-5.3-flash-free", name: "glm-5.3-flash-free" },
    { id: "longcat-2.5-preview-free", name: "longcat-2.5-preview-free" },
    { id: "minimax-m3.1-flash-free", name: "minimax-m3.1-flash-free" },
    { id: "big-pickle", name: "big-pickle" },
  ],
};

export default opencodeConfig;
