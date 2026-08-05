import { describe, it, expect, beforeEach, afterEach } from "vitest";

// kiroModels.resolveKiroModels surfaces the upstream context window as a
// `capabilities.contextWindow` on every synthetic variant, so /v1/models can
// resolve it dynamically instead of falling back to the hand-edited static
// capability table (which must be patched per model generation — the bug that
// caused kr/claude-opus-5 to wrongly resolve to 200k).
describe("kiroModels context capability sync", () => {
  const originalFetch = globalThis.fetch;

  const makeRawModels = () => [
    {
      modelId: "claude-opus-5",
      modelName: "Claude Opus 5",
      tokenLimits: { maxInputTokens: 1000000 },
    },
    {
      modelId: "claude-sonnet-4.5",
      modelName: "Claude Sonnet 4.5",
      tokenLimits: { maxInputTokens: 200000 },
    },
  ];

  const mockCatalog = (raw) => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: raw }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  };

  beforeEach(() => {
    // clear any cached catalog from other tests in this file
    return import("../../open-sse/services/kiroModels.js").then((m) => m.clearKiroModelCache());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("carries the upstream context window into capabilities.contextWindow on each variant", async () => {
    mockCatalog(makeRawModels());
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const creds = { accessToken: "tok", providerSpecificData: {} };
    const { models } = await resolveKiroModels(creds, { forceRefresh: true });

    const opus = models.filter((m) => m.id.startsWith("claude-opus-5"));
    expect(opus.length).toBeGreaterThanOrEqual(4); // base + thinking + agentic + thinking-agentic
    for (const m of opus) {
      expect(m.capabilities?.contextWindow).toBe(1000000);
      expect(m.contextLength).toBe(1000000);
    }

    const sonnet = models.find((m) => m.id === "claude-sonnet-4.5");
    expect(sonnet.capabilities?.contextWindow).toBe(200000);
  });

  it("keeps existing variant capability flags (thinking/agentic) when adding contextWindow", async () => {
    mockCatalog([{ modelId: "claude-opus-5", modelName: "Claude Opus 5", tokenLimits: { maxInputTokens: 1000000 } }]);
    const { resolveKiroModels } = await import("../../open-sse/services/kiroModels.js");
    const { models } = await resolveKiroModels({ accessToken: "tok", providerSpecificData: {} }, { forceRefresh: true });

    const thinking = models.find((m) => m.id === "claude-opus-5-thinking");
    expect(thinking.capabilities).toMatchObject({ thinking: true, agentic: false, contextWindow: 1000000 });
    const agentic = models.find((m) => m.id === "claude-opus-5-agentic");
    expect(agentic.capabilities).toMatchObject({ thinking: false, agentic: true, contextWindow: 1000000 });
  });
});
