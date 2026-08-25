import { describe, it, expect } from "vitest";
import bai from "../../open-sse/providers/registry/bai.js";
import { APIKEY_PROVIDERS, isPublicModelsProvider, providerSupportsModelSync } from "../../src/shared/constants/providers.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LOGO = join(here, "../../public/providers/bai.png");

describe("B.AI provider", () => {
  it("registers as an API-key provider with B.AI display", () => {
    expect(bai.id).toBe("bai");
    expect(bai.category).toBe("apikey");
    expect(bai.alias).toBe("bai");
    expect(bai.display.name).toBe("B.AI");
    expect(APIKEY_PROVIDERS.bai).toBeDefined();
    expect(APIKEY_PROVIDERS.bai.id).toBe("bai");
    expect(APIKEY_PROVIDERS.bai.passthroughModels).toBe(true);
  });

  it("points at api.b.ai OpenAI-compatible chat + models URLs", () => {
    expect(bai.transport.baseUrl).toBe("https://api.b.ai/v1/chat/completions");
    expect(bai.transport.validateUrl).toBe("https://api.b.ai/v1/models");
    expect(PROVIDERS.bai.baseUrl).toBe("https://api.b.ai/v1/chat/completions");
    expect(PROVIDERS.bai.format).toBe("openai");
  });

  it("exposes an OpenAI-style modelsFetcher and passthroughModels", () => {
    expect(bai.modelsFetcher).toEqual({
      url: "https://api.b.ai/v1/models",
      type: "openai",
    });
    expect(bai.passthroughModels).toBe(true);
  });

  it("seeds documented ids only (no invented mimo-v2.5)", () => {
    const ids = bai.models.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("hy3");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("deepseek-v4-flash-vision-exp");
    expect(ids).toContain("gpt-5.2");
    expect(ids).toContain("glm-5.2");
    expect(ids).not.toContain("mimo-v2.5");
    expect(ids).not.toContain("mimo-v2.5-omni");
  });

  it("resolves bai / b-ai / b.ai aliases and slash model strings", () => {
    expect(resolveProviderAlias("bai")).toBe("bai");
    expect(resolveProviderAlias("b-ai")).toBe("bai");
    expect(resolveProviderAlias("b.ai")).toBe("bai");
    expect(parseModel("bai/deepseek-v4-flash")).toEqual({
      provider: "bai",
      model: "deepseek-v4-flash",
      isAlias: false,
      providerAlias: "bai",
    });
    expect(parseModel("b.ai/gpt-5.2")).toEqual({
      provider: "bai",
      model: "gpt-5.2",
      isAlias: false,
      providerAlias: "b.ai",
    });
  });

  it("does not treat GET /v1/models as public (401 without key) but still supports sync", () => {
    expect(isPublicModelsProvider("bai")).toBe(false);
    expect(providerSupportsModelSync("bai")).toBe(true);
  });

  it("declares DeepSeek V4 Flash as reasoning text-only 1M, vision-exp as vision, hy3 as 256k", () => {
    const flash = getCapabilitiesForModel("bai", "deepseek-v4-flash");
    expect(flash.vision).toBe(false);
    expect(flash.reasoning).toBe(true);
    expect(flash.contextWindow).toBe(1000000);

    const visionExp = getCapabilitiesForModel("bai", "deepseek-v4-flash-vision-exp");
    expect(visionExp.vision).toBe(true);
    expect(visionExp.contextWindow).toBe(1000000);

    const hy3 = getCapabilitiesForModel("bai", "hy3");
    expect(hy3.contextWindow).toBe(262144);
    expect(hy3.contextWindow).not.toBe(1000000);
  });

  it("ships a dashboard logo at /providers/bai.png", () => {
    expect(existsSync(LOGO)).toBe(true);
  });

  it("does not mark limited-time 0-credit promos as a permanent free SKU", () => {
    expect(bai.hasFree).toBeUndefined();
    expect(bai.category).not.toBe("freeTier");
    expect(bai.display.notice.text).toMatch(/not a documented permanent \$0 SKU/i);
  });
});
