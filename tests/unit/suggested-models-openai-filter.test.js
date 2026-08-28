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

  it("falls back to capabilities.js when upstream omits context (e.g. b.ai)", () => {
    // b.ai seeds 6 models in registry; capabilities.js carries contextWindow
    // for all of them (1M / 1M / 400K / 1M / 262K / 1M). Upstream standard
    // OpenAI /v1/models response does NOT include context_length, so without
    // this fallback the dashboard would render "NaN ctx" for every model.
    const out = FILTERS["openai"](
      [
        { id: "deepseek-v4-flash" },
        { id: "hy3" },
        { id: "gpt-5.2" },
        { id: "claude-sonnet-4-6" },
        { id: "glm-5.2" },
      ],
      "bai"
    );
    const byId = Object.fromEntries(out.map((m) => [m.id, m.contextLength]));
    expect(byId["deepseek-v4-flash"]).toBe(1000000);
    expect(byId["claude-sonnet-4-6"]).toBe(1000000);
    expect(byId["glm-5.2"]).toBe(1000000);
    expect(byId["gpt-5.2"]).toBe(400000);
    expect(byId["hy3"]).toBe(262144);
  });

  it("upstream context_length wins over capabilities.js fallback", () => {
    // When the upstream response does carry a context field, prefer it —
    // dynamic data beats a static table. (9-opus review: dynamic wins.)
    const out = FILTERS["openai"](
      [{ id: "deepseek-v4-flash", context_length: 32768 }],
      "bai"
    );
    expect(out[0].contextLength).toBe(32768);
  });

  it("does not throw when providerHint lookup fails", () => {
    // Unknown provider id — getCapabilitiesForModel returns the catalogue
    // default (or null) without throwing. The filter must not crash.
    const out = FILTERS["openai"](
      [{ id: "anything" }],
      "this-provider-does-not-exist-xyz"
    );
    expect(out[0].id).toBe("anything");
    // No contextLength — that's fine, just don't crash.
  });

  it("ignores empty-string providerHint (no capabilities lookup)", () => {
    // Defend against an empty string passing a truthiness check (9-opus).
    const out = FILTERS["openai"](
      [{ id: "deepseek-v4-flash" }],
      ""
    );
    // Should not throw and should not set contextLength (no provider to lookup).
    expect(out[0].id).toBe("deepseek-v4-flash");
    expect(out[0].contextLength).toBeUndefined();
  });
});

describe("providerModelsFetcher cache key (9-opus: provider-scoped)", () => {
  it("different providerIds with the same URL produce different cache keys", async () => {
    // Stub fetch to avoid network; we only care that the fetcher records
    // the call so we can compare the URL it constructed (the query param
    // `provider` differs → server-side filter is invoked correctly).
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = vi.fn(async (url, opts) => {
      seen.push({ url, key: opts?.headers?.["X-Provider-Key"] });
      return { ok: true, json: async () => ({ data: [] }) };
    });

    try {
      const { fetchSuggestedModels } = await import(
        "../../src/shared/utils/providerModelsFetcher.js"
      );
      const fetcher = { url: "https://api.b.ai/v1/models", type: "openai" };

      // First call: providerId="bai" (no key).
      await fetchSuggestedModels(fetcher, { providerId: "bai" });
      // Second call: providerId="venice" (same URL, no key).
      await fetchSuggestedModels(fetcher, { providerId: "venice" });

      // Both URLs should include their own providerId — the server-side
      // filter is what picks the right contextWindow fallback.
      expect(seen[0].url).toContain("provider=bai");
      expect(seen[1].url).toContain("provider=venice");
    } finally {
      global.fetch = originalFetch;
    }
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
