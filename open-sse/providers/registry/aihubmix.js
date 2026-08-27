/**
 * AIHubMix — OpenAI-compatible LLM aggregator
 * https://docs.aihubmix.com/en/
 * Unified endpoint for text, vision, audio, video, and embedding models.
 * Includes free-tier models (e.g. glm-5.2-free) and auto router model IDs.
 */
const aihubmixConfig = {
  id: "aihubmix",
  priority: 60,
  hasFree: true,
  alias: "aihubmix",
  display: {
    name: "AIHubMix",
    icon: "hub",
    color: "#6366F1",
    textIcon: "AIHM",
    website: "https://aihubmix.com",
    notice: {
      text: "OpenAI-compatible LLM aggregator with 850+ models including free tier and auto router.",
      apiKeyUrl: "https://aihubmix.com/dashboard/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://aihubmix.com/v1/chat/completions",
    validateUrl: "https://aihubmix.com/v1/models",
    format: "openai",
  },
  models: [
    // Auto router (built-in)
    { id: "auto", name: "Auto Router" },
    { id: "auto:balanced", name: "Auto: Balanced" },
    { id: "auto:quality_first", name: "Auto: Quality First" },
    { id: "auto:latency_critical", name: "Auto: Latency Critical" },
    // Free tier
    { id: "glm-5.2-free", name: "GLM 5.2 (Free)" },
    { id: "dots-3-note-preview-free", name: "Dots 3 Note Preview (Free)" },
    { id: "gemini-3.7-flash-free", name: "Gemini 3.7 Flash (Free)" },
  ],
  serviceKinds: ["llm", "imageToText"],
};

export default aihubmixConfig;
