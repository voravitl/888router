import { describe, it, expect, beforeEach, vi } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import nvidiaRegistry from "../../open-sse/providers/registry/nvidia.js";
import nousresearchRegistry from "../../open-sse/providers/registry/nousresearch.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
  getAllModelDynamicCapabilities: vi.fn(async () => new Map()),
  resolveKiroModels: vi.fn(async () => null),
  resolveQoderModels: vi.fn(async () => null),
  resolveKimchiModels: vi.fn(async () => null),
  resolveCopilotModels: vi.fn(async () => null),
  resolveClinepassModels: vi.fn(async () => null),
  listAvailableModels: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/db", () => ({
  getAllModelDynamicCapabilities: mocks.getAllModelDynamicCapabilities,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("open-sse/providers/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, registerDynamicCapabilitiesScoped: vi.fn() };
});

vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: mocks.resolveKiroModels }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: mocks.resolveQoderModels }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: mocks.resolveKimchiModels }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: mocks.resolveCopilotModels }));
vi.mock("open-sse/services/clinepassModels.js", () => ({ resolveClinepassModels: mocks.resolveClinepassModels }));
vi.mock("@/lib/oauth/services/ollama", () => ({
  OllamaService: class {
    async listAvailableModels() {
      return mocks.listAvailableModels();
    }
  },
}));
vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  refreshGoogleToken: vi.fn(async () => ({ accessToken: "x" })),
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");

describe("Fix A: Cloudflare Workers AI requireStringContent quirk", () => {
  it("normalizes null, omitted, and text-only array content to plain strings", () => {
    const exec = new DefaultExecutor("cloudflare-ai");
    const messages = [
      { role: "system", content: [{ type: "text", text: "Line 1" }, { type: "text", text: "Line 2" }] },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } }],
      },
      {
        role: "assistant",
        tool_calls: [{ id: "tc_2", type: "function", function: { name: "shell", arguments: '{"command":"pwd"}' } }],
      },
    ];

    const body = { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages };
    const out = exec.transformRequest("@cf/meta/llama-3.3-70b-instruct-fp8-fast", body, true, {});

    expect(out.messages[0].content).toBe("Line 1Line 2");
    expect(out.messages[1].content).toBe("hi");
    expect(out.messages[2].content).toBe("");
    expect(out.messages[2].tool_calls).toHaveLength(1);
    expect(out.messages[3].content).toBe("");
    expect(out.messages[3].tool_calls).toHaveLength(1);
  });
});

describe("Fix B & C1: NVIDIA EOL & Nous dead-seed cleanup", () => {
  it("removes the 5 dead/EOL NVIDIA NIM models while keeping live ones", () => {
    const ids = nvidiaRegistry.models.map((m) => m.id);
    for (const dead of [
      "minimaxai/minimax-m2.7",
      "z-ai/glm-5.2",
      "deepseek-ai/deepseek-v4-pro",
      "deepseek-ai/deepseek-v4-flash",
      "moonshotai/kimi-k2.6",
    ]) {
      expect(ids, `nvidia should not contain ${dead}`).not.toContain(dead);
    }
    for (const alive of [
      "minimaxai/minimax-m3.1-flash",
      "moonshotai/kimi-k3.1-pro",
      "z-ai/glm-5.3-flash",
      "google/gemma-4-31b-it",
      "mistralai/mistral-large-4-1t-a52b",
      "stepfun-ai/step-5-preview",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]) {
      expect(ids, `nvidia should keep ${alive}`).toContain(alive);
    }
  });

  it("removes retired nousresearch/hermes-4-405b and voyageai/voyage-4 seeds from nousresearch", () => {
    const ids = nousresearchRegistry.models.map((m) => m.id);
    expect(ids).not.toContain("nousresearch/hermes-4-405b");
    expect(ids).not.toContain("voyageai/voyage-4");
    expect(ids).toContain("google/gemini-4-neon");
    expect(ids).toContain("anthropic/claude-fable-5.2");
  });
});

describe("Fix C2: /v1/models preserves upstream vendor prefix (no double-prefix stripping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelDynamicCapabilities.mockResolvedValue(new Map());
  });

  it("preserves vendor-prefixed static IDs like nvidia/nemotron-3-ultra-550b-a55b", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-nv", provider: "nvidia", isActive: true, apiKey: "nvapi-test", providerSpecificData: {} },
    ]);

    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m) => m.id);

    expect(ids).toContain("nvidia/nvidia/nemotron-3-ultra-550b-a55b");
    expect(ids).not.toContain("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("preserves vendor-prefixed custom/enabled IDs like nous/nousresearch/foo while stripping redundant router prefix on claude", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-nous",
        provider: "nousresearch",
        isActive: true,
        apiKey: "sk-test",
        providerSpecificData: { enabledModels: ["nousresearch/hermes-custom", "nous/google/gemini-4-neon"] },
      },
      {
        id: "conn-cc",
        provider: "claude",
        isActive: true,
        apiKey: "sk-ant-oat-test",
        providerSpecificData: { enabledModels: ["cc/claude-sonnet-5-5"] },
      },
    ]);

    const res = await GET(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m) => m.id);

    expect(ids).toContain("nous/nousresearch/hermes-custom");
    expect(ids).not.toContain("nous/hermes-custom");
    expect(ids).toContain("nous/google/gemini-4-neon");
    expect(ids).toContain("cc/claude-sonnet-5-5");
    expect(ids).not.toContain("cc/cc/claude-sonnet-5-5");
  });
});
