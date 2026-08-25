import { describe, it, expect } from "vitest";
import gmi from "../../open-sse/providers/registry/gmi.js";
import { APIKEY_PROVIDERS, isPublicModelsProvider, providerSupportsModelSync } from "../../src/shared/constants/providers.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LOGO = join(here, "../../public/providers/gmi.png");

describe("GMI Cloud provider", () => {
  it("registers as an API-key OpenAI-compatible provider", () => {
    expect(gmi.id).toBe("gmi");
    expect(gmi.category).toBe("apikey");
    expect(gmi.alias).toBe("gmi");
    expect(gmi.display.name).toBe("GMI Cloud");
    expect(APIKEY_PROVIDERS.gmi).toBeDefined();
    expect(APIKEY_PROVIDERS.gmi.passthroughModels).toBe(true);
  });

  it("points at api.gmi-serving.com (OpenAI-compatible)", () => {
    // https://www.gmicloud.ai/en/developers and https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference
    expect(gmi.transport.baseUrl).toBe("https://api.gmi-serving.com/v1/chat/completions");
    expect(gmi.transport.validateUrl).toBe("https://api.gmi-serving.com/v1/models");
    expect(PROVIDERS.gmi.baseUrl).toBe("https://api.gmi-serving.com/v1/chat/completions");
    expect(PROVIDERS.gmi.format).toBe("openai");
  });

  it("exposes an OpenAI-style modelsFetcher and passthrough for the live catalogue", () => {
    expect(gmi.modelsFetcher).toEqual({
      url: "https://api.gmi-serving.com/v1/models",
      type: "openai",
    });
    expect(gmi.passthroughModels).toBe(true);
  });

  it("seeds moonshotai/kimi-k3 from the GMI Kimi K3 blog curl", () => {
    // https://www.gmicloud.ai/en/blog/kimi-k3-open-weights-are-here-the-benchmark-phase-starts-now
    const ids = gmi.models.map((m) => m.id);
    expect(ids).toEqual(["moonshotai/kimi-k3", "deepseek-ai/DeepSeek-V4-Pro"]);
    // Not on GMI developers/blog curls — do not invent OpenClaw-only ids.
    expect(ids).not.toContain("openai/gpt-5.6-sol");
    expect(ids).not.toContain("anthropic/claude-sonnet-5");
    expect(ids).not.toContain("google/gemini-3.5-flash-lite");
    expect(ids).not.toContain("zai-org/GLM-5.2-FP8");
  });

  it("resolves gmi / gmi-cloud / gmicloud aliases and slash-in-id model strings", () => {
    expect(resolveProviderAlias("gmi")).toBe("gmi");
    expect(resolveProviderAlias("gmi-cloud")).toBe("gmi");
    expect(resolveProviderAlias("gmicloud")).toBe("gmi");
    expect(parseModel("gmi/moonshotai/kimi-k3")).toEqual({
      provider: "gmi",
      model: "moonshotai/kimi-k3",
      isAlias: false,
      providerAlias: "gmi",
    });
  });

  it("requires a key for /v1/models (observed 401 without Authorization)", () => {
    expect(isPublicModelsProvider("gmi")).toBe(false);
    expect(providerSupportsModelSync("gmi")).toBe(true);
  });

  it("treats kimi-k3 as 1M vision reasoning via the family glob", () => {
    const caps = getCapabilitiesForModel("gmi", "moonshotai/kimi-k3");
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
  });

  it("ships a dashboard logo at /providers/gmi.png", () => {
    expect(existsSync(LOGO)).toBe(true);
  });
});
