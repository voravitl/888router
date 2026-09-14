import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isFreeCandidate } from "../../open-sse/services/autoCombo/virtualFactory.js";

// Evidence: public /pricing page crawled 2026-09-13 — 50 chat models + 3 legacy aliases,
// 10 free surfaces with 7M/day recurring pool on free tier.
// Upstream /v1/models requires admin permissions (403 on standard user keys), so
// 888router serves the curated seed snapshot directly without modelsFetcher.
describe("nara provider registration", () => {
  it("registry entry exposes valid seed models without duplicates + chat transport", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    expect(entry).toBeTruthy();
    expect(entry.models.length).toBeGreaterThanOrEqual(50);
    expect(entry.modelsFetcher).toBeUndefined();
    expect(entry.transport.baseUrl).toBe("https://router.bynara.id/v1/chat/completions");

    // Assert unique IDs and well-formed entries
    const ids = entry.models.map((m) => (typeof m === "string" ? m : m.id));
    expect(new Set(ids).size).toBe(entry.models.length);
    for (const model of entry.models) {
      const id = typeof model === "string" ? model : model.id;
      const name = typeof model === "string" ? model : model.name;
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }

    // Assert non-chat media models and defunct models are excluded
    const denylist = ["agnes-video-v2.0", "agnes-image-2.0-flash", "agnes-image-2.1-flash", "grok-imagine", "nano-banana-pro", "ling-3.0-flash-fin-free"];
    for (const denied of denylist) {
      expect(ids).not.toContain(denied);
    }

    // Verify active free and free_for_paid surfaces present in seed
    for (const id of [
      "agnes-2.5-flash",
      "laguna-s-2.1",
      "stepfun-3.7-flash",
      "tencent-hy3-free",
      "deepseek-v4.1-flash-free",
      "glm-5.3-free",
      "mimo-v2.5-free",
      "muse-spark-1.3-contributor-free",
      "qwen3.8-flash-free",
    ]) {
      expect(entry.models.some((m) => (typeof m === "string" ? m : m.id) === id), id).toBe(true);
    }
  });

  it("all 4 verified free catalog surfaces pass the free-tier gate (paid siblings do not)", async () => {
    const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.js");
    const freeIds = FREE_MODEL_BUDGETS.filter((f) => f.provider === "nara").map((f) => f.modelId);
    expect(new Set(freeIds)).toEqual(
      new Set(["agnes-2.5-flash", "laguna-s-2.1", "stepfun-3.7-flash", "tencent-hy3-free"])
    );
    for (const id of freeIds) {
      expect(isFreeCandidate("nara", id), `nara/${id} must pass isFreeCandidate`).toBe(true);
    }
    for (const id of [
      "deepseek-v4.1-flash",
      "mimo-v2.5",
      "glm-5.3",
      "claude-opus-5",
      "deepseek-v4.1-flash-free",
      "glm-5.3-free",
      "mimo-v2.5-free",
      "muse-spark-1.3-contributor-free",
      "qwen3.8-flash-free",
      "ling-3.0-flash-fin-free",
    ]) {
      expect(isFreeCandidate("nara", id), id).toBe(false);
    }
  });

  it("free catalog rows resolve against the registry seed", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.js");
    const rows = FREE_MODEL_BUDGETS.filter((f) => f.provider === "nara");
    expect(new Set(rows.map((r) => r.modelId))).toEqual(
      new Set(["agnes-2.5-flash", "laguna-s-2.1", "stepfun-3.7-flash", "tencent-hy3-free"])
    );
    for (const row of rows) {
      const reg = (PROVIDERS["nara"]?.models || []).find((x) =>
        typeof x === "string" ? x === row.modelId : x?.id === row.modelId,
      );
      expect(reg, `nara/${row.modelId} in registry`).toBeTruthy();
    }
  });

  it("legacy compatibility models are retained", async () => {
    const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
    const entry = REGISTRY.find((r) => r.id === "nara");
    const ids = entry.models.map((m) => (typeof m === "string" ? m : m.id));
    expect(ids).toContain("tencent-hy3");
    expect(ids).toContain("mistral-large");
    expect(ids).toContain("mistral-medium-3-5");
  });

  it("short aliases resolve via ALIAS_TO_ID + getProviderByAlias", async () => {
    const { ALIAS_TO_ID, getProviderByAlias } = await import("../../src/shared/constants/providers.js");
    expect(ALIAS_TO_ID["nara"]).toBe("nara");
    expect(ALIAS_TO_ID["nararouter"]).toBe("nara");
    expect(ALIAS_TO_ID["bynara"]).toBe("nara");
    expect(ALIAS_TO_ID["by-nara"]).toBe("nara");
    expect(getProviderByAlias("nararouter")?.id).toBe("nara");
    expect(getProviderByAlias("bynara")?.id).toBe("nara");
    expect(getProviderByAlias("by-nara")?.id).toBe("nara");
  });

  it("free members appear in auto/best-free candidates and excluded models do not", async () => {
    const { resolveVirtualAutoCombo } = await import("../../open-sse/services/autoCombo/virtualFactory.js");
    const combo = resolveVirtualAutoCombo("auto/best-free");
    expect(combo).not.toBeNull();
    expect(combo.models).toContain("nara/tencent-hy3-free");
    expect(combo.models).toContain("nara/agnes-2.5-flash");
    expect(combo.models).toContain("nara/laguna-s-2.1");
    expect(combo.models).toContain("nara/stepfun-3.7-flash");

    const excluded = [
      "nara/deepseek-v4.1-flash-free",
      "nara/glm-5.3-free",
      "nara/mimo-v2.5-free",
      "nara/muse-spark-1.3-contributor-free",
      "nara/qwen3.8-flash-free",
      "nara/ling-3.0-flash-fin-free",
    ];
    for (const id of excluded) {
      expect(combo.models).not.toContain(id);
    }
  });

  it("provider logo PNG exists in public/providers and has valid PNG header", () => {
    const logoPath = resolve(process.cwd(), "public/providers/nara.png");
    expect(existsSync(logoPath), "public/providers/nara.png exists").toBe(true);
    const buf = readFileSync(logoPath);
    // PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });

  it("keyed gateway needs a connection: no virtual injection for nara", async () => {
    const { AI_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    const def = AI_PROVIDERS["nara"];
    expect(def, "nara registered in AI_PROVIDERS").toBeDefined();
    expect(def.noAuth, "nara is keyed (no virtual injection)").toBeFalsy();
  });

  it("nara and aliases are registered as public models providers", async () => {
    const { isPublicModelsProvider } = await import("../../src/shared/constants/providers.js");
    expect(isPublicModelsProvider("nara")).toBe(true);
    expect(isPublicModelsProvider("nararouter")).toBe(true);
    expect(isPublicModelsProvider("bynara")).toBe(true);
    expect(isPublicModelsProvider("by-nara")).toBe(true);
  });

  describe("nara API key validation and models sync", () => {
    it("validates nara key with 200 OK probe response", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async (url, opts) => {
          expect(url).toBe("https://router.bynara.id/v1/chat/completions");
          expect(opts.method).toBe("POST");
          return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-valid" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(true);
        expect(data.error).toBeNull();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("surfaces telegram_required error clearly", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async (url) => {
          return new Response(JSON.stringify({
            error: { type: "forbidden", message: "telegram_required: Please bind your Telegram account at /settings to continue." }
          }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-unbound" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(false);
        expect(data.error).toContain("Telegram");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("treats 429 quota / insufficient credits as accepted key", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => {
          return new Response(JSON.stringify({
            error: { message: "Insufficient credits. Please top up your balance." }
          }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-nocredit" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("rejects 401 unauthorized as invalid API key even if body mentions plan", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => {
          return new Response(JSON.stringify({
            error: { message: "Invalid API key — check your plan balance" }
          }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-bad" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(false);
        expect(data.error).toBe("Invalid API key");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("rejects 200 with malformed or missing choices response", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => {
          return new Response("<html>Maintenance</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-test" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(false);
        expect(data.error).toContain("invalid completion response");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("accepts 403 plan exclusion as valid key", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => {
          return new Response(JSON.stringify({
            error: { type: "forbidden", message: "Your plan does not include the requested model." }
          }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-plan-limit" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("rejects generic 429 without credits/quota message", async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => {
          return new Response(JSON.stringify({
            error: { message: "Too many requests from this IP" }
          }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        };
        const { POST } = await import("../../src/app/api/providers/validate/route.js");
        const req = new Request("http://localhost/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "nara", apiKey: "sk-ip-ratelimit" }),
        });
        const res = await POST(req);
        const data = await res.json();
        expect(data.valid).toBe(false);
        expect(data.error).toContain("Too many requests");
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
