import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

describe("suggested-models 'openai' filter (closes #319)", () => {
  it("parses { data: [{ id, ... }] } into { id, name }", () => {
    const out = FILTERS["openai"]([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "claude-sonnet-4-6" },
    ]);
    expect(out).toEqual([
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ]);
  });

  it("extracts context_length / contextWindow / maxInputTokens into contextLength", () => {
    const out = FILTERS["openai"]([
      { id: "m1", context_length: 200000 },
      { id: "m2", contextWindow: 1000000 },
      { id: "m3", maxInputTokens: 128000 },
      { id: "m4" },
    ]);
    expect(out[0].contextLength).toBe(200000);
    expect(out[1].contextLength).toBe(1000000);
    expect(out[2].contextLength).toBe(128000);
    expect(out[3].contextLength).toBeUndefined();
  });

  it("drops models with no id", () => {
    const out = FILTERS["openai"]([
      { id: "ok" },
      { name: "no-id" },
      null,
      undefined,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ok");
  });

  it("returns [] for empty input", () => {
    expect(FILTERS["openai"]([])).toEqual([]);
  });

  it("drops non-numeric context_length to avoid NaN (9-opus review)", () => {
    const out = FILTERS["openai"]([
      { id: "m1", context_length: "abc" },
      { id: "m2", context_length: "128000" },
      { id: "m3", contextWindow: null },
      { id: "m4" },
    ]);
    expect(out[0].contextLength).toBeUndefined();
    expect(out[1].contextLength).toBe(128000);
    expect(out[2].contextLength).toBeUndefined();
    expect(out[3].contextLength).toBeUndefined();
  });
});

describe("providerModelsFetcher cache key (9-opus review: collision fix)", () => {
  it("different apiKeys produce different cache keys", async () => {
    const { fetchSuggestedModels } = await import(
      "../../src/shared/utils/providerModelsFetcher.js"
    );
    // The fetcher uses /api/providers/suggested-models proxy. We don't need
    // it to actually call — we just want to verify the cache key differs.
    // Mock fetch to return empty so we don't hit the network.
    const originalFetch = global.fetch;
    let calledWith = null;
    global.fetch = vi.fn(async (url, opts) => {
      calledWith = { url, opts };
      return { ok: true, json: async () => ({ data: [] }) };
    });

    try {
      const fetcher = { url: "https://api.b.ai/v1/models", type: "openai" };
      await fetchSuggestedModels(fetcher, { apiKey: "key-A" });
      const urlA = calledWith.url;
      const headerA = calledWith.opts?.headers?.["X-Provider-Key"];

      calledWith = null;
      await fetchSuggestedModels(fetcher, { apiKey: "key-B" });
      const urlB = calledWith.url;
      const headerB = calledWith.opts?.headers?.["X-Provider-Key"];

      // Neither call should ever put the key in the URL.
      expect(urlA).not.toContain("key-A");
      expect(urlB).not.toContain("key-B");
      // Key travels via header, not query.
      expect(headerA).toBe("key-A");
      expect(headerB).toBe("key-B");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("suggested-models route", () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("attaches Authorization: Bearer when X-Provider-Key header provided", async () => {
    const captured = { headers: null };
    global.fetch = vi.fn(async (_url, opts) => {
      captured.headers = opts?.headers;
      return {
        ok: true,
        json: async () => ({ data: [{ id: "x" }] }),
      };
    });

    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const req = new Request(
      "http://localhost/api/providers/suggested-models?url=https%3A%2F%2Fapi.b.ai%2Fv1%2Fmodels&type=openai",
      { headers: { "X-Provider-Key": "secret123" } }
    );
    await GET(req);

    expect(captured.headers.Authorization).toBe("Bearer secret123");
  });

  it("omits Authorization when no X-Provider-Key (anonymous)", async () => {
    const captured = { headers: null };
    global.fetch = vi.fn(async (_url, opts) => {
      captured.headers = opts?.headers;
      return { ok: true, json: async () => ({ data: [] }) };
    });

    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const req = new Request(
      "http://localhost/api/providers/suggested-models?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fmodels&type=openai"
    );
    await GET(req);

    expect(captured.headers.Authorization).toBeUndefined();
  });

  it("returns 400 for unknown filter type", async () => {
    const { GET } = await import("../../src/app/api/providers/suggested-models/route.js");
    const req = new Request(
      "http://localhost/api/providers/suggested-models?url=https%3A%2F%2Fx.com%2Fmodels&type=does-not-exist"
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
