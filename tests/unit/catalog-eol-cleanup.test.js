import { describe, it, expect } from "vitest";
import { FREE_MODEL_BUDGETS } from "../../open-sse/config/freeModelCatalog.data.js";
import nvidiaRegistry from "../../open-sse/providers/registry/nvidia.js";
import nousresearchRegistry from "../../open-sse/providers/registry/nousresearch.js";
import ollamaRegistry from "../../open-sse/providers/registry/ollama.js";
import opencodeRegistry from "../../open-sse/providers/registry/opencode.js";
import opencodeGoRegistry from "../../open-sse/providers/registry/opencode-go.js";
import { PROVIDER_MODELS, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";

describe("Registry & Free Model Catalog EOL cleanup (2026-11-19)", () => {
  it("removes @cf/moonshotai/kimi-k2.6 from cloudflare-ai in freeModelCatalog while keeping live entries", () => {
    const cfModels = FREE_MODEL_BUDGETS
      .filter((entry) => entry.provider === "cloudflare-ai")
      .map((entry) => entry.modelId);

    expect(cfModels).not.toContain("@cf/moonshotai/kimi-k2.6");
    expect(cfModels).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("removes EOL minimaxai/minimax-m3 and adds verified live models in nvidia", () => {
    const regIds = nvidiaRegistry.models.map((m) => m.id);
    const modelIds = (PROVIDER_MODELS.nvidia || []).map((m) => m.id);

    expect(regIds).not.toContain("minimaxai/minimax-m3");
    expect(modelIds).not.toContain("minimaxai/minimax-m3");

    const added = [
      ["minimaxai/minimax-m3.1-flash", "MiniMax M3.1 Flash"],
      ["moonshotai/kimi-k3.1-pro", "Kimi K3.1 Pro"],
      ["z-ai/glm-5.3-flash", "GLM 5.3 Flash"],
      ["google/gemma-4-31b-it", "Gemma 4 31B IT"],
      ["mistralai/mistral-large-4-1t-a52b", "Mistral Large 4"],
      ["stepfun-ai/step-5-preview", "Step 5 Preview"],
    ];
    for (const [id, name] of added) {
      const entry = nvidiaRegistry.models.find((m) => m.id === id);
      expect(entry, `nvidia missing ${id}`).toBeDefined();
      expect(entry.name).toBe(name);
      expect(modelIds).toContain(id);
    }
    for (const dead of [
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.2",
      "deepseek-ai/deepseek-v4-pro",
      "deepseek-ai/deepseek-v4-flash",
      "moonshotai/kimi-k2.6",
    ]) {
      expect(regIds).not.toContain(dead);
      expect(modelIds).not.toContain(dead);
    }
    expect(modelIds).toContain("nvidia/nv-embedqa-e5-v5");
  });

  it("removes retired nousresearch/hermes-4-70b, hermes-4-405b, and voyage-4 and keeps live featured models in nousresearch", () => {
    const ids = nousresearchRegistry.models.map((m) => m.id);
    const modelIds = (PROVIDER_MODELS.nous || []).map((m) => m.id);

    expect(ids).not.toContain("nousresearch/hermes-4-70b");
    expect(modelIds).not.toContain("nousresearch/hermes-4-70b");
    expect(ids).not.toContain("nousresearch/hermes-4-405b");
    expect(ids).not.toContain("voyageai/voyage-4");

    const added = [
      ["google/gemini-4-neon", "Gemini 4 Neon"],
      ["google/gemini-4-hydrogen", "Gemini 4 Hydrogen"],
      ["anthropic/claude-fable-5.2", "Claude Fable 5.2"],
    ];
    for (const [id, name] of added) {
      const entry = nousresearchRegistry.models.find((m) => m.id === id);
      expect(entry, `nousresearch missing ${id}`).toBeDefined();
      expect(entry.name).toBe(name);
      expect(modelIds).toContain(id);
    }
  });

  it("replaces retired static ollama entries with all 22 verified live Ollama Cloud models", () => {
    const retired = ["kimi-k2.5", "glm-5", "minimax-m2.5", "glm-4.7-flash", "qwen3.5"];
    const expectedLive = [
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro:0813",
      "kimi-k3.1-pro",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "minimax-m3",
      "minimax-m3.1-flash",
      "gemma4:31b",
      "nemotron-3-ultra",
      "nemotron-3-super",
      "mistral-large-4",
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "gpt-oss:120b",
      "gpt-oss:20b",
      "beam",
      "inkling-2-small",
      "muse-spark-open",
    ];

    const regIds = ollamaRegistry.models.map((m) => m.id);
    const modelIds = (PROVIDER_MODELS.ollama || []).map((m) => m.id);

    for (const id of retired) {
      expect(regIds).not.toContain(id);
      expect(modelIds).not.toContain(id);
    }
    expect(regIds).toHaveLength(22);
    expect(new Set(regIds)).toEqual(new Set(expectedLive));
    expect(new Set(modelIds)).toEqual(new Set(expectedLive));
  });

  it("updates opencode free catalog to exact 10 live models", () => {
    const retired = [
      "glm-5.3-flash-free",
      "pulse-alpha-free",
      "crouton-alpha-free",
      "longcat-2.5-free",
      "inkling-2-small-free",
      "tidepool-alpha-free",
    ];
    const expectedLive = [
      "nemotron-3.5-lightning-free",
      "nemotron-3.5-super-vl-free",
      "mimo-v2.6-flash-free",
      "beam-free",
      "deepseek-v4.1-flash-free",
      "flint-40b-free",
      "big-pickle",
      "iceman-free",
      "hy4-flash-free",
      "seaglass-alpha-free",
    ];

    const regIds = opencodeRegistry.models.map((m) => m.id);
    const modelIds = (PROVIDER_MODELS.oc || []).map((m) => m.id);

    for (const id of retired) {
      expect(regIds).not.toContain(id);
      expect(modelIds).not.toContain(id);
    }
    expect(regIds).toHaveLength(10);
    expect(new Set(regIds)).toEqual(new Set(expectedLive));
    expect(new Set(modelIds)).toEqual(new Set(expectedLive));
  });

  it("adds hy4-flash-free and qwen4-max with openai supportedFormats to opencode-go, and drops retired longcat-2.5-free (410 live 2026-11-27)", () => {
    const added = [
      ["hy4-flash-free", "Hy4 Flash Free"],
      ["qwen4-max", "Qwen 4 Max"],
    ];

    for (const [id, name] of added) {
      const entry = opencodeGoRegistry.models.find((m) => m.id === id);
      expect(entry, `opencode-go missing ${id}`).toBeDefined();
      expect(entry).toEqual({ id, name, supportedFormats: ["openai"] });
      expect(getModelSupportedFormats("opencode-go", id)).toEqual(["openai"]);
    }

    expect(
      opencodeGoRegistry.models.find((m) => m.id === "longcat-2.5-free"),
      "opencode-go must not advertise retired longcat-2.5-free"
    ).toBeUndefined();
  });
});
