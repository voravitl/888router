export default {
  id: "nousresearch",
  priority: 65,
  alias: "nous",
  display: {
    name: "NousResearch",
    icon: "psychology",
    color: "#7000FF",
    textIcon: "NR",
    website: "https://nousresearch.com",
    notice: {
      apiKeyUrl: "https://openrouter.ai/keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    validateUrl: "https://openrouter.ai/api/v1/models",
  },
  models: [
    { id: "nousresearch/hermes-4-405b", name: "Hermes 4 405B" },
    { id: "nousresearch/hermes-4-70b", name: "Hermes 4 70B" },
    { id: "nousresearch/hermes-3-llama-3.1-405b", name: "Hermes 3 Llama 3.1 405B" },
    { id: "nousresearch/hermes-3-llama-3.1-70b", name: "Hermes 3 Llama 3.1 70B" },
    { id: "nousresearch/deephermes-3-llama-3-8b-preview", name: "DeepHermes 3 Llama 3 8B" },
    { id: "nousresearch/hermes-2-pro-llama-3-8b", name: "Hermes 2 Pro Llama 3 8B" },
    { id: "nousresearch/nous-hermes-2-mixtral-8x7b-dpo", name: "Nous Hermes 2 Mixtral 8x7B DPO" },
  ],
  serviceKinds: ["llm"],
};
