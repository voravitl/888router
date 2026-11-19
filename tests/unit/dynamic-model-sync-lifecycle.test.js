import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared contract for the model-sync redesign:
//   upstream metadata → normalized capabilities → persisted "active" rows →
//   "stale" ghosts on a later successful sync → clean lookups on every surface.
const mocks = vi.hoisted(() => ({
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  getSyncedModelsMap: vi.fn(async () => ({})),
  getModelDynamicCapabilities: vi.fn(async () => null),
  stampSyncedModels: vi.fn(async () => ({})),
  saveModelDynamicCapabilities: vi.fn(async () => {}),
  getModelAliases: vi.fn(async () => ({})),
  setModelAlias: vi.fn(async () => {}),
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getComboByName: vi.fn(async () => null),
  getDisabledModels: vi.fn(async () => ({})),
  refreshGoogleToken: vi.fn(async () => null),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: (...a) => mocks.getAllModelDynamicCapabilities(...a),
  getSyncedModelsMap: (...a) => mocks.getSyncedModelsMap(...a),
  getModelDynamicCapabilities: (...a) => mocks.getModelDynamicCapabilities(...a),
  stampSyncedModels: (...a) => mocks.stampSyncedModels(...a),
  saveModelDynamicCapabilities: (...a) => mocks.saveModelDynamicCapabilities(...a),
  initDb: vi.fn(async () => {}),
}));
vi.mock("@/models", () => ({
  getModelAliases: (...a) => mocks.getModelAliases(...a),
  setModelAlias: (...a) => mocks.setModelAlias(...a),
  getProviderConnectionById: vi.fn(async () => null),
  getProviderConnections: (...a) => mocks.getProviderConnections(...a),
}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: (...a) => mocks.getProviderConnections(...a),
  getCombos: (...a) => mocks.getCombos(...a),
  getCustomModels: (...a) => mocks.getCustomModels(...a),
  getModelAliases: (...a) => mocks.getModelAliases(...a),
  getComboByName: (...a) => mocks.getComboByName(...a),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: (...a) => mocks.getDisabledModels(...a),
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: (...a) => mocks.refreshGoogleToken(...a),
  updateProviderCredentials: (...a) => mocks.updateProviderCredentials(...a),
}));
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: vi.fn(async () => null) }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: vi.fn(async () => null) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, json: async () => body }) },
}));

const SYNCED_MAP = new Map([
  ["opencode-go:hy4-flash-free", {
    contextWindow: 256000,
    maxOutput: 64000,
    vision: true,
    pdf: true,
    audioInput: true,
    videoInput: true,
    tools: true,
    reasoning: true,
    search: false,
    releasedAt: "2026-01-02T00:00:00.000Z",
  }],
]);

describe("normalizeUpstreamModel", () => {
  it("normalizes the OpenCode Go hy4-flash-free rich upstream shape", async () => {
    const { normalizeUpstreamModel, collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const raw = {
      id: "hy4-flash-free",
      object: "model",
      created: 1767321600, // epoch seconds -> ISO
      modalities: {
        input: ["text", "image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "audio/*", "video/*"],
        output: ["text"],
      },
      limit: { context: 256000, output: 64000 },
      capabilities: { reasoning: { supported: true }, tools: { supported: true } },
      search: true,
    };

    const model = normalizeUpstreamModel("opencode-go", raw);
    expect(model.id).toBe("hy4-flash-free");
    expect(model.vision).toBe(true);
    expect(model.pdf).toBe(true);
    expect(model.audioInput).toBe(true);
    expect(model.videoInput).toBe(true);
    expect(model.contextWindow).toBe(256000);
    expect(model.context_length).toBe(256000);
    expect(model.maxOutput).toBe(64000);
    expect(model.reasoning).toBe(true);
    expect(model.tools).toBe(true);
    expect(model.search).toBe(true);
    expect(String(model.releasedAt)).toMatch(/^2026-01-02T/);
    // Input object is never mutated.
    expect(raw.vision).toBeUndefined();
    expect(raw.contextWindow).toBeUndefined();

    expect(collectNormalizedCapabilities(model)).toMatchObject({
      contextWindow: 256000,
      maxOutput: 64000,
      vision: true,
      pdf: true,
      reasoning: true,
    });
  });

  it("handles the short ['text','image'] modality form and explicit booleans", async () => {
    const { normalizeUpstreamModel } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const short = normalizeUpstreamModel("opencode", {
      id: "short",
      input_modalities: ["text", "image"],
      context_length: 200000,
      max_tokens: 32000,
    });
    expect(short.vision).toBe(true);
    expect(short.contextWindow).toBe(200000);
    expect(short.maxOutput).toBe(32000);

    // An explicit upstream boolean wins over a stale modality list.
    const explicit = normalizeUpstreamModel("opencode", {
      id: "explicit",
      modalities: { input: ["text", "image"] },
      supportsImages: false,
    });
    expect(explicit.vision).toBe(false);
  });

  it("normalizes Anthropic /v1/models wire shape (display_name, max_input_tokens, capabilities.*.supported)", async () => {
    const { normalizeUpstreamModel, collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const raw = {
      type: "model",
      id: "claude-fable-5-2",
      display_name: "Claude Fable 5.2",
      created_at: "2026-11-09T18:30:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: {
        image_input: { supported: true },
        pdf_input: { supported: true },
        server_tools: { supported: true, web_search: { supported: true } },
        thinking: {
          supported: true,
          types: {
            enabled: { supported: false },
            adaptive: { supported: true },
          },
        },
      },
    };

    const model = normalizeUpstreamModel("claude", raw);
    expect(model.name).toBe("Claude Fable 5.2");
    expect(model.contextWindow).toBe(1000000);
    expect(model.context_length).toBe(1000000);
    expect(model.maxOutput).toBe(128000);
    expect(model.vision).toBe(true);
    expect(model.pdf).toBe(true);
    expect(model.reasoning).toBe(true);
    expect(model.search).toBe(true);
    expect(model.releasedAt).toBe("2026-11-09T18:30:00.000Z");
    expect(collectNormalizedCapabilities(model)).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
      vision: true,
      pdf: true,
      reasoning: true,
      search: true,
    });
  });

  it("normalizes OpenRouter & NousResearch modalities, reasoning objects, maxOutput, and supported_parameters", async () => {
    const { normalizeUpstreamModel, collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );

    const openrouterRich = normalizeUpstreamModel("openrouter", {
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 65536 },
      architecture: {
        input_modalities: ["file", "image", "text", "video", "audio"],
        modality: "text->text",
      },
      reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["low", "medium", "high"] },
      supported_parameters: ["tools", "web_search"],
    });
    expect(openrouterRich.vision).toBe(true);
    expect(openrouterRich.pdf).toBe(true);
    expect(openrouterRich.audioInput).toBe(true);
    expect(openrouterRich.videoInput).toBe(true);
    expect(openrouterRich.maxOutput).toBe(65536);
    expect(openrouterRich.reasoning).toBe(true);
    expect(openrouterRich.tools).toBe(true);
    expect(openrouterRich.search).toBe(true);

    // Fallback to architecture.modality string when input_modalities is absent
    const modalityFallback = normalizeUpstreamModel("openrouter", {
      id: "nousresearch/hermes-vision",
      architecture: { modality: "text+image+file->text" },
      outputTokenLimit: 16384,
      supported_parameters: ["include_reasoning", "tool_choice", "web_search_options"],
    });
    expect(modalityFallback.vision).toBe(true);
    expect(modalityFallback.pdf).toBe(true);
    expect(modalityFallback.maxOutput).toBe(16384);
    expect(modalityFallback.reasoning).toBe(true);
    expect(modalityFallback.tools).toBe(true);
    expect(modalityFallback.search).toBe(true);

    // architecture.input_modalities wins over architecture.modality string
    const inputModalitiesWin = normalizeUpstreamModel("openrouter", {
      id: "text-only-override",
      architecture: {
        input_modalities: ["text"],
        modality: "text+image+file->text",
      },
      output_token_limit: 8192,
      supported_parameters: ["reasoning_effort", "functions"],
    });
    expect(inputModalitiesWin.vision).toBe(false);
    expect(inputModalitiesWin.pdf).toBe(false);
    expect(inputModalitiesWin.maxOutput).toBe(8192);
    expect(inputModalitiesWin.reasoning).toBe(true);
    expect(inputModalitiesWin.tools).toBe(true);
    expect(inputModalitiesWin.search).toBeUndefined();

    // reasoning: { enabled: false } resolves to false; document modality -> pdf: true; limit.max_output_tokens
    const disabledReasoning = normalizeUpstreamModel("nousresearch", {
      id: "hermes-4",
      modalities: { input: ["text", "document"] },
      limit: { context: 131072, max_output_tokens: 32768 },
      reasoning: { enabled: false },
      supported_parameters: ["reasoning", "temperature"],
    });
    expect(disabledReasoning.pdf).toBe(true);
    expect(disabledReasoning.maxOutput).toBe(32768);
    expect(disabledReasoning.reasoning).toBe(false);
    expect(disabledReasoning.tools).toBeUndefined();

    // limit.max_tokens & non-boolean empty reasoning {}
    const emptyReasoningObj = normalizeUpstreamModel("openrouter", {
      id: "plain-model",
      limit: { context: 64000, max_tokens: 4096 },
      reasoning: {},
      supported_parameters: ["thinking"],
    });
    expect(emptyReasoningObj.maxOutput).toBe(4096);
    expect(emptyReasoningObj.reasoning).toBe(true);

    const unresolvedReasoningObj = normalizeUpstreamModel("openrouter", {
      id: "raw-obj-model",
      reasoning: {},
    });
    expect(unresolvedReasoningObj.reasoning).toBeUndefined();
    expect(collectNormalizedCapabilities(unresolvedReasoningObj)).toEqual({});
  });

  it("normalizes Codex capabilities (supported_reasoning_levels, parallel tools, apply_patch, web_search_tool_type)", async () => {
    const { normalizeUpstreamModel } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );

    const codexFull = normalizeUpstreamModel("codex", {
      id: "gpt-5.3-codex",
      max_context_window: 400000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
      default_reasoning_level: "medium",
      supports_parallel_tool_calls: true,
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
    });
    expect(codexFull.vision).toBe(true);
    expect(codexFull.reasoning).toBe(true);
    expect(codexFull.tools).toBe(true);
    expect(codexFull.search).toBe(true);

    const codexToolCalling = normalizeUpstreamModel("codex", {
      id: "gpt-5-codex-mini",
      default_reasoning_level: "high",
      toolCalling: true,
    });
    expect(codexToolCalling.reasoning).toBe(true);
    expect(codexToolCalling.tools).toBe(true);

    const codexPatchOnly = normalizeUpstreamModel("codex", {
      id: "gpt-5-patch",
      apply_patch_tool_type: "freeform",
    });
    expect(codexPatchOnly.tools).toBe(true);

    // "none" and empty arrays must NOT fabricate true
    const codexNone = normalizeUpstreamModel("codex", {
      id: "gpt-codex-none",
      supported_reasoning_levels: [],
      default_reasoning_level: "none",
      supports_parallel_tool_calls: false,
      apply_patch_tool_type: "none",
      web_search_tool_type: "none",
    });
    expect(codexNone.reasoning).toBeUndefined();
    expect(codexNone.tools).toBeUndefined();
    expect(codexNone.search).toBeUndefined();
  });

  it("normalizes GitHub Copilot capabilities.limits and capabilities.supports", async () => {
    const { normalizeUpstreamModel, collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );

    const copilot = normalizeUpstreamModel("github", {
      id: "claude-opus-4.6",
      name: "Claude Opus 4.6",
      capabilities: {
        type: "chat",
        limits: {
          max_context_window_tokens: 200000,
          max_prompt_tokens: 128000,
          max_output_tokens: 32000,
          max_thinking_budget: 16000,
        },
        supports: {
          vision: true,
          tool_calls: true,
          parallel_tool_calls: true,
          thinking: true,
        },
      },
    });
    expect(copilot.contextWindow).toBe(200000);
    expect(copilot.maxOutput).toBe(32000);
    expect(copilot.vision).toBe(true);
    expect(copilot.tools).toBe(true);
    expect(copilot.reasoning).toBe(true);
    expect(collectNormalizedCapabilities(copilot)).toMatchObject({
      contextWindow: 200000,
      maxOutput: 32000,
      vision: true,
      tools: true,
      reasoning: true,
    });

    const copilotPromptBudget = normalizeUpstreamModel("github", {
      id: "o3-mini",
      capabilities: {
        type: "chat",
        limits: {
          max_prompt_tokens: 100000,
          max_thinking_budget: 8192,
        },
        supports: {
          vision: false,
          parallel_tool_calls: true,
        },
      },
    });
    expect(copilotPromptBudget.contextWindow).toBe(100000);
    expect(copilotPromptBudget.vision).toBe(false);
    expect(copilotPromptBudget.tools).toBe(true);
    expect(copilotPromptBudget.reasoning).toBe(true);
  });

  it("rejects non-boolean objects and invalid types in collectNormalizedCapabilities", async () => {
    const { collectNormalizedCapabilities } = await import(
      "../../open-sse/services/upstreamModelNormalizer.js"
    );
    const sanitized = collectNormalizedCapabilities({
      id: "dirty",
      vision: "yes",
      pdf: 1,
      audioInput: {},
      videoInput: [],
      tools: "true",
      reasoning: { mandatory: true },
      search: null,
      contextWindow: -100,
      maxOutput: Number.NaN,
      releasedAt: "",
    });
    expect(sanitized).toEqual({});

    const valid = collectNormalizedCapabilities({
      vision: false,
      reasoning: true,
      contextWindow: 128000,
      maxOutput: 8192,
      releasedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(valid).toEqual({
      vision: false,
      reasoning: true,
      contextWindow: 128000,
      maxOutput: 8192,
      releasedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("sets vision: true on Cloudflare AI vision tasks without mislabeling text-to-image or text-generation", async () => {
    const { parseCloudflareModelsResponse } = await import(
      "../../src/lib/cloudflareAiModels.js"
    );
    const parsed = parseCloudflareModelsResponse({
      result: [
        { id: "@cf/unum/uform-gen2-qwen-500m", name: "@cf/unum/uform-gen2-qwen-500m", task: { name: "Image-to-Text" } },
        { id: "@cf/meta/llama-3.2-11b-vision-instruct", name: "@cf/meta/llama-3.2-11b-vision-instruct", task: { name: "Image Text to Text" } },
        { id: "@cf/llava/llava-1.5-7b-hf", name: "@cf/llava/llava-1.5-7b-hf", task: { name: "Visual Question Answering" } },
        { id: "@cf/custom/visual-caption", name: "@cf/custom/visual-caption", task: { name: "Visual Captioning" } },
        { id: "@cf/black-forest-labs/flux-1-schnell", name: "@cf/black-forest-labs/flux-1-schnell", task: { name: "Text-to-Image" } },
        { id: "@cf/meta/llama-3.3-70b", name: "@cf/meta/llama-3.3-70b", task: { name: "Text Generation" } },
      ],
    });
    const byId = Object.fromEntries(parsed.map((m) => [m.id, m]));
    expect(byId["@cf/unum/uform-gen2-qwen-500m"]).toMatchObject({ kind: "llm", vision: true });
    expect(byId["@cf/meta/llama-3.2-11b-vision-instruct"]).toMatchObject({ kind: "llm", vision: true });
    expect(byId["@cf/llava/llava-1.5-7b-hf"]).toMatchObject({ kind: "llm", vision: true });
    expect(byId["@cf/custom/visual-caption"]).toMatchObject({ kind: "llm", vision: true });
    expect(byId["@cf/black-forest-labs/flux-1-schnell"].kind).toBe("image");
    expect(byId["@cf/black-forest-labs/flux-1-schnell"].vision).toBeUndefined();
    expect(byId["@cf/meta/llama-3.3-70b"].kind).toBe("llm");
    expect(byId["@cf/meta/llama-3.3-70b"].vision).toBeUndefined();
  });

  it("normalizes FILTERS['openrouter-free'] entries while preserving id, name, contextLength", async () => {
    const { FILTERS } = await import(
      "../../src/app/api/providers/suggested-models/filters.js"
    );
    const out = FILTERS["openrouter-free"]([
      {
        id: "text/free-256k",
        display_name: "Text Free 256K",
        context_length: 256000,
        pricing: { prompt: "0", completion: "0" },
        architecture: { modality: "text->text" },
        reasoning: {},
      },
      {
        id: "google/gemini-2.5-pro:free",
        name: "Gemini 2.5 Pro Free",
        context_length: 1000000,
        created: 1767321600,
        pricing: { prompt: "0", completion: "0" },
        architecture: { input_modalities: ["text", "image", "file"] },
        top_provider: { max_completion_tokens: 65536 },
        reasoning: { mandatory: true },
        supported_parameters: ["tools", "web_search"],
      },
      {
        id: "paid/model",
        name: "Paid",
        context_length: 1000000,
        pricing: { prompt: "0.001", completion: "0.002" },
      },
      {
        id: "small/free",
        name: "Small Free",
        context_length: 32000,
        pricing: { prompt: "0", completion: "0" },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "google/gemini-2.5-pro:free",
      name: "Gemini 2.5 Pro Free",
      contextLength: 1000000,
      maxOutput: 65536,
      vision: true,
      pdf: true,
      reasoning: true,
      tools: true,
      search: true,
    });
    expect(String(out[0].releasedAt)).toMatch(/^2026-01-02T/);
    expect(out[1]).toMatchObject({
      id: "text/free-256k",
      name: "Text Free 256K",
      contextLength: 256000,
      vision: false,
      pdf: false,
    });
    expect(out[1].reasoning).toBeUndefined();
  });
});

describe("reconcileSyncedModelsForConnection", () => {
  let tempDir;
  let originalDataDir;
  let repo;

  beforeEach(async () => {
    originalDataDir = process.env.DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-sync-lifecycle-"));
    process.env.DATA_DIR = tempDir;
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter } = await import("@/lib/db/driver.js");
    await getAdapter();
    repo = await import("@/lib/db/repos/syncedModelsRepo.js");
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("transitions absent ids to stale, keeps ghosts, and clears on re-stamp", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-02-01T00:00:00.000Z";
    await repo.stampSyncedModels([
      { connectionId: "conn-ocg", modelId: "hy4-flash-free" },
      { connectionId: "conn-ocg", modelId: "retired-model" },
    ], { now: t1 });

    let map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:hy4-flash-free"].status).toBe("active");
    expect(map["conn-ocg:retired-model"].status).toBe("active");
    expect(map["conn-ocg:hy4-flash-free"].lastSyncedAt).toBe(t1);

    const changed = await repo.reconcileSyncedModelsForConnection(
      "conn-ocg", ["hy4-flash-free"], { now: t2 }
    );
    expect(Object.keys(changed)).toEqual(["conn-ocg:retired-model"]);

    map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:retired-model"].status).toBe("stale");
    expect(map["conn-ocg:retired-model"].missingSince).toBe(t2);
    expect(map["conn-ocg:retired-model"].firstSeenAt).toBe(t1);
    expect(map["conn-ocg:hy4-flash-free"].status).toBe("active");

    // A later sync must not refresh a ghost's missingSince.
    await repo.reconcileSyncedModelsForConnection(
      "conn-ocg", ["hy4-flash-free"], { now: "2026-03-01T00:00:00.000Z" }
    );
    map = await repo.getSyncedModelsMap();
    expect(map["conn-ocg:retired-model"].missingSince).toBe(t2);

    // Seeing the model again clears the ghost marker but keeps firstSeenAt.
    const restamped = await repo.stampSyncedModels(
      [{ connectionId: "conn-ocg", modelId: "retired-model" }], { now: t2 }
    );
    expect(restamped["conn-ocg:retired-model"].status).toBe("active");
    expect(restamped["conn-ocg:retired-model"].missingSince).toBeUndefined();
    expect(restamped["conn-ocg:retired-model"].firstSeenAt).toBe(t1);
  });

  it("never marks anything stale on an empty or failed upstream response", async () => {
    await repo.stampSyncedModels([{ connectionId: "conn-empty", modelId: "m1" }]);
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", [])).toEqual({});
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", null)).toEqual({});
    expect(await repo.reconcileSyncedModelsForConnection("conn-empty", "m1")).toEqual({});
    const map = await repo.getSyncedModelsMap();
    expect(map["conn-empty:m1"].status).toBe("active");
    expect(map["conn-empty:m1"].missingSince).toBeUndefined();
  });

  it("keeps vision-only capability rows but rejects malformed contextWindow", async () => {
    await repo.saveModelDynamicCapabilities("opencode-go", "vision-only", { vision: true });
    await repo.saveModelDynamicCapabilities("opencode-go", "bad-cw", { contextWindow: 1, vision: true });
    const all = await repo.getAllModelDynamicCapabilities();
    expect(all.get("opencode-go:vision-only").vision).toBe(true);
    expect(all.has("opencode-go:bad-cw")).toBe(false);
  });
});

describe("synced capabilities on HTTP surfaces", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getAllModelDynamicCapabilities.mockReset().mockResolvedValue(SYNCED_MAP);
    mocks.getSyncedModelsMap.mockReset().mockResolvedValue({
      "conn-ocg:hy4-flash-free": { status: "active", firstSeenAt: "t1", lastSyncedAt: "t2" },
    });
    mocks.getModelDynamicCapabilities.mockReset().mockImplementation(async (providerId, modelId) => {
      return SYNCED_MAP.get(`${providerId}:${String(modelId).split("/").pop()}`) || null;
    });
    mocks.getModelAliases.mockReset().mockResolvedValue({});
    mocks.getDisabledModels.mockReset().mockResolvedValue({});
    mocks.getProviderConnections.mockReset().mockResolvedValue([]);
    mocks.getCombos.mockReset().mockResolvedValue([]);
    mocks.getCustomModels.mockReset().mockResolvedValue([]);
  });

  it("GET /api/models exposes dynamicCapsByKey under both provider id and alias", async () => {
    const { GET } = await import("../../src/app/api/models/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dynamicCapsByKey["ocg/hy4-flash-free"].vision).toBe(true);
    expect(data.dynamicCapsByKey["opencode-go/hy4-flash-free"].maxOutput).toBe(64000);
    expect(data.dynamicCapsByKey["ocg/hy4-flash-free"].pdf).toBe(true);
    expect(data.models.some((m) => m.fullModel === "opencode-go/hy4-flash-free")).toBe(true);
  });

  it("GET /api/models isolates stale status per provider without hiding another provider's active model", async () => {
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map([
      ["opencode-go:shared-model", { contextWindow: 128000, vision: true }],
      ["openrouter:shared-model", { contextWindow: 128000, vision: false }],
    ]));
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-ocg", provider: "opencode-go" },
      { id: "conn-or", provider: "openrouter" },
    ]);
    mocks.getSyncedModelsMap.mockResolvedValue({
      "conn-ocg:shared-model": { status: "active", firstSeenAt: "t1", lastSyncedAt: "t2" },
      "conn-or:shared-model": { status: "stale", firstSeenAt: "t1", missingSince: "t2" },
    });
    const { GET } = await import("../../src/app/api/models/route.js");
    const res = await GET();
    const data = await res.json();
    expect(data.models.some((m) => m.fullModel === "opencode-go/shared-model")).toBe(true);
    expect(data.models.some((m) => m.fullModel === "openrouter/shared-model")).toBe(false);
    expect(data.dynamicCapsByKey["openrouter/shared-model"].vision).toBe(false);
  });

  it("GET /api/v1/models/info?id=ocg/uncatalogued-flash-free resolves from synced caps", async () => {
    mocks.getModelDynamicCapabilities.mockResolvedValueOnce(SYNCED_MAP.get("opencode-go:hy4-flash-free"));
    mocks.getSyncedModelsMap.mockResolvedValueOnce({
      "conn-ocg:uncatalogued-flash-free": { status: "active", firstSeenAt: "t1", lastSyncedAt: "t2" },
    });
    const { GET } = await import("../../src/app/api/v1/models/info/route.js");
    const res = await GET(new Request("http://localhost/v1/models/info?id=ocg/uncatalogued-flash-free"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vision).toBe(true);
    expect(body.capabilities.vision).toBe(true);
    expect(body.contextWindow).toBe(256000);
    expect(body.max_tokens).toBe(64000);
    expect(body.status).toBe("active");
    expect(body.source).toBe("synced");
  });

  it("GET /api/v1/models/info still 404s for an unknown synced-less model", async () => {
    mocks.getModelDynamicCapabilities.mockResolvedValue(null);
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
    const { GET } = await import("../../src/app/api/v1/models/info/route.js");
    const res = await GET(new Request("http://localhost/v1/models/info?id=ocg/no-such-model"));
    expect(res.status).toBe(404);
  });
});

describe("buildModelsResponse reconciliation guard", () => {
  let reconcile;

  beforeEach(() => {
    reconcile = vi.fn(async () => ({}));
    vi.doMock("@/lib/db/repos/syncedModelsRepo.js", () => ({ reconcileSyncedModelsForConnection: reconcile }));
    vi.resetModules();
    mocks.stampSyncedModels.mockReset().mockResolvedValue({});
    mocks.getSyncedModelsMap.mockReset().mockResolvedValue({});
    mocks.saveModelDynamicCapabilities.mockReset().mockResolvedValue();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/db/repos/syncedModelsRepo.js");
  });

  it("reconciles a live non-empty model list", async () => {
    const { buildModelsResponse } = await import("../../src/app/api/providers/[id]/models/route.js");
    await buildModelsResponse({
      provider: "opencode-go",
      connectionId: "conn-live",
      models: [{ id: "hy4-flash-free" }],
    });
    expect(reconcile).toHaveBeenCalledWith("conn-live", ["hy4-flash-free"]);
  });

  it("does not reconcile a static fallback list even when non-empty", async () => {
    const { buildModelsResponse } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await buildModelsResponse({
      provider: "xai",
      connectionId: "conn-stale-fallback",
      models: [{ id: "grok-4" }],
      reconcile: false,
    });
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not stamp or save dynamic capabilities when reconcile is false, while preserving prior syncedMap metadata", async () => {
    mocks.getSyncedModelsMap.mockResolvedValueOnce({
      "conn-fallback:grok-4": {
        lastSyncedAt: "2026-01-01T00:00:00.000Z",
        firstSeenAt: "2025-12-01T00:00:00.000Z",
        status: "stale",
        missingSince: "2026-01-02T00:00:00.000Z",
      },
    });
    const { buildModelsResponse } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await buildModelsResponse({
      provider: "xai",
      connectionId: "conn-fallback",
      models: [
        { id: "grok-4", contextWindow: 131072, vision: true },
        { id: "grok-static-only", contextWindow: 64000 },
      ],
      reconcile: false,
    });
    const body = await res.json();

    expect(mocks.stampSyncedModels).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(mocks.saveModelDynamicCapabilities).not.toHaveBeenCalled();
    expect(mocks.getSyncedModelsMap).toHaveBeenCalledTimes(1);

    expect(body.models).toHaveLength(2);
    expect(body.models[0]).toMatchObject({
      id: "grok-4",
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
      firstSeenAt: "2025-12-01T00:00:00.000Z",
      status: "stale",
      missingSince: "2026-01-02T00:00:00.000Z",
      source: "synced",
    });
    expect(body.models[1]).toMatchObject({
      id: "grok-static-only",
      lastSyncedAt: null,
      firstSeenAt: null,
      status: "active",
      missingSince: null,
      source: "static",
    });
  });
});
