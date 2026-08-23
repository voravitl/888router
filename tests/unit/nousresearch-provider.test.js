import { describe, it, expect } from "vitest";
import nousresearch from "../../open-sse/providers/registry/nousresearch.js";
import { APIKEY_PROVIDERS, isPublicModelsProvider, providerSupportsModelSync } from "../../src/shared/constants/providers.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LOGO = join(here, "../../public/providers/nousresearch.png");

describe("Nous Research Portal provider", () => {
  it("registers as an API-key provider with Nous Portal display", () => {
    expect(nousresearch.id).toBe("nousresearch");
    expect(nousresearch.category).toBe("apikey");
    expect(nousresearch.alias).toBe("nous");
    expect(nousresearch.display.name).toBe("Nous Research");
    expect(APIKEY_PROVIDERS.nousresearch).toBeDefined();
    expect(APIKEY_PROVIDERS.nousresearch.id).toBe("nousresearch");
    expect(APIKEY_PROVIDERS.nousresearch.passthroughModels).toBe(true);
  });

  it("points at the native inference API, not OpenRouter", () => {
    expect(nousresearch.transport.baseUrl).toBe("https://inference-api.nousresearch.com/v1/chat/completions");
    expect(nousresearch.transport.validateUrl).toBe("https://inference-api.nousresearch.com/v1/models");
    expect(nousresearch.transport.baseUrl).not.toContain("openrouter.ai");
    expect(PROVIDERS.nousresearch.baseUrl).toBe("https://inference-api.nousresearch.com/v1/chat/completions");
  });

  it("exposes an OpenAI-style modelsFetcher and embedding endpoint", () => {
    expect(nousresearch.modelsFetcher).toEqual({
      url: "https://inference-api.nousresearch.com/v1/models",
      type: "openai",
    });
    expect(nousresearch.passthroughModels).toBe(true);
    expect(nousresearch.serviceKinds).toEqual(["llm", "embedding"]);
    expect(nousresearch.embeddingConfig.baseUrl).toBe("https://inference-api.nousresearch.com/v1/embeddings");
  });

  it("seeds live Hermes 4 + agentic catalog ids (2026-08-23 Portal /v1/models)", () => {
    const ids = nousresearch.models.map((m) => m.id);
    expect(ids).toContain("nousresearch/hermes-4-405b");
    expect(ids).toContain("nousresearch/hermes-4-70b");
    expect(ids).toContain("anthropic/claude-sonnet-4.6");
    expect(ids).not.toContain("nousresearch/hermes-3-llama-3.1-405b");
  });

  it("resolves nous / nous-portal aliases and slash-in-id model strings", () => {
    expect(resolveProviderAlias("nous")).toBe("nousresearch");
    expect(resolveProviderAlias("nous-portal")).toBe("nousresearch");
    expect(resolveProviderAlias("nousresearch")).toBe("nousresearch");
    expect(parseModel("nous/nousresearch/hermes-4-70b")).toEqual({
      provider: "nousresearch",
      model: "nousresearch/hermes-4-70b",
      isAlias: false,
      providerAlias: "nous",
    });
  });

  it("allows public model sync because GET /v1/models is unauthenticated", () => {
    expect(isPublicModelsProvider("nousresearch")).toBe(true);
    expect(providerSupportsModelSync("nousresearch")).toBe(true);
  });

  it("declares Hermes 4 as reasoning text-only with 131k context", () => {
    const caps = getCapabilitiesForModel("nousresearch", "nousresearch/hermes-4-70b");
    expect(caps.reasoning).toBe(true);
    expect(caps.vision).toBe(false);
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.contextWindow).toBe(131072);
  });

  it("ships a dashboard logo at /providers/nousresearch.png", () => {
    expect(existsSync(LOGO)).toBe(true);
  });
});
