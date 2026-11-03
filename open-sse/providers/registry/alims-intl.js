// Model Studio Intl — standard DashScope API keys (sk-...), NOT Coding Plan keys.
// Sibling of alicode-intl (Coding Plan). Two key types use two different hosts.
// Model list verified live 2026-11-03 against dashscope-intl; the previous set
// (kimi-k2.5, glm-5, MiniMax-M2.5, qwen3-coder-*, glm-4.7) now 404s upstream.
export default {
  id: "alims-intl",
  priority: 11,
  alias: "alims-intl",
  display: {
    name: "Alibaba Studio",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ALi",
    website: "https://modelstudio.console.alibabacloud.com",
    notice: {
      apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?apiKey=1",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    headers: {},
    quirks: { preserveCacheControl: true },
  },
  models: [
    { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.7-flash", name: "Qwen3.7 Flash" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    // Quota is per model: the alias and the dated snapshot draw on separate
    // free-tier pools, so keep both — one can be exhausted while the other works.
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash (1017)" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash" },
  ],
};
