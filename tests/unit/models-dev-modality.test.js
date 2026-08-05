import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// modelsDevModality.enrichModalityFromModelsDev pulls vision/reasoning/context
// from models.dev (authoritative) so opencode's modality-less /zen/v1/models
// sync doesn't forward image_url to text-only models (400 "unknown variant
// image_url"). This is the MECHANISM fix — new models get correct modality
// automatically instead of a per-model static-table patch.
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../../open-sse/services/modelsDevModality.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // keep the real module; we only control global fetch below
  };
});

import {
  enrichModalityFromModelsDev,
  clearModelsDevCache,
} from "../../open-sse/services/modelsDevModality.js";

const MODELS_DEV = {
  opencode: {
    models: {
      "deepseek-v4-flash-free": {
        modalities: { input: ["text"] },
        reasoning: true,
        limit: { context: 200000 },
      },
      "mimo-v2.5-free": {
        modalities: { input: ["text", "image", "audio", "video"] },
        reasoning: true,
        limit: { context: 200000 },
      },
      "ling-3.0-flash-free": {
        modalities: { input: ["text"] },
        reasoning: true,
        limit: { context: 262144 },
      },
    },
  },
};

describe("enrichModalityFromModelsDev", () => {
  beforeEach(() => {
    clearModelsDevCache();
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => MODELS_DEV,
    });
    globalThis.fetch = mocks.fetch;
  });

  afterEach(() => {
    delete globalThis.fetch;
  });

  it("marks text-only models vision=false (fixes the 400 image_url bug)", async () => {
    const models = [{ id: "deepseek-v4-flash-free" }];
    await enrichModalityFromModelsDev(models, "opencode");
    expect(models[0].vision).toBe(false);
    expect(models[0].reasoning).toBe(true);
    expect(models[0].context_length).toBe(200000);
  });

  it("marks vision-capable models vision=true", async () => {
    const models = [{ id: "mimo-v2.5-free" }];
    await enrichModalityFromModelsDev(models, "opencode");
    expect(models[0].vision).toBe(true);
  });

  it("leaves unknown models untouched (fail-open to static table)", async () => {
    const models = [{ id: "brand-new-model-free" }];
    await enrichModalityFromModelsDev(models, "opencode");
    expect(models[0].vision).toBeUndefined();
    expect(models[0].reasoning).toBeUndefined();
  });

  it("does not override an explicit upstream vision field", async () => {
    const models = [{ id: "deepseek-v4-flash-free", vision: true }];
    await enrichModalityFromModelsDev(models, "opencode");
    // upstream wins — we only fill when undefined
    expect(models[0].vision).toBe(true);
  });

  it("fails open (returns models unchanged) when models.dev is unreachable", async () => {
    clearModelsDevCache(); // ensure a fresh fetch attempt
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });
    const models = [{ id: "deepseek-v4-flash-free" }];
    await enrichModalityFromModelsDev(models, "opencode");
    expect(models[0].vision).toBeUndefined();
  });
});
