import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression: Ollama /api/tags returns { models: [{ name, model, details }] }
// with NO `id` field. The old ollama-local branch used parseOpenAIStyleModels
// passthrough, so buildModelsResponse's `m.id` filter dropped every model and
// Sync Models showed an empty list. The branch must normalize name → id.

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

const TAGS_PAYLOAD = {
  models: [
    {
      name: "qwen2.5-coder:14b-instruct-q8_0",
      model: "qwen2.5-coder:14b-instruct-q8_0",
      modified_at: "2026-09-17T21:14:02.448512617+07:00",
      size: 15701611656,
      digest: "bd9a836c38a9a418d26843ecfeece8ed3c127977c9f82c33830ba49498acaa0a",
      details: { format: "gguf", family: "qwen2", parameter_size: "14.8B", quantization_level: "Q8_0", context_length: 32768 },
    },
    {
      name: "qwen2.5:14b-instruct-q8_0",
      model: "qwen2.5:14b-instruct-q8_0",
      modified_at: "2026-09-17T21:09:21.23331236+07:00",
      size: 15701611427,
      details: { format: "gguf", family: "qwen2", parameter_size: "14.8B", quantization_level: "Q8_0", context_length: 32768 },
    },
  ],
};

describe("ollama-local models route — /api/tags normalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes tags name → id so sync list is non-empty", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ollama-local-1",
      provider: "ollama-local",
      apiKey: "",
      providerSpecificData: { baseUrl: "https://ollama.olanla66.org" },
    });
    const calls = [];
    global.fetch = (url, opts) => {
      calls.push([url, opts]);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TAGS_PAYLOAD) });
    };

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const res = await GET(new Request("http://localhost/api/providers/conn-ollama-local-1/models"), {
      params: Promise.resolve({ id: "conn-ollama-local-1" }),
    });
    const body = await res.json();

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://ollama.olanla66.org/api/tags");
    expect(calls[0][1]).toMatchObject({ method: "GET" });
    expect(body.models).toHaveLength(2);
    expect(body.models.map((m) => m.id)).toEqual([
      "qwen2.5-coder:14b-instruct-q8_0",
      "qwen2.5:14b-instruct-q8_0",
    ]);
    expect(body.models[0].contextLength).toBe(32768);
    expect(body.warning).toBeUndefined();
  });

  it("falls back to localhost default when baseUrl absent", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-ollama-local-2",
      provider: "ollama-local",
      apiKey: "",
    });
    const calls = [];
    global.fetch = (url, opts) => {
      calls.push([url, opts]);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TAGS_PAYLOAD) });
    };

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    await GET(new Request("http://localhost/api/providers/conn-ollama-local-2/models"), {
      params: Promise.resolve({ id: "conn-ollama-local-2" }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("http://localhost:11434/api/tags");
  });
});
