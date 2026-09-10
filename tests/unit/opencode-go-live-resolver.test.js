import { describe, expect, it, beforeEach } from "vitest";
import {
  parseOpenCodeGoCatalog,
  normalizeOpenCodeGoModel,
  resolveOpenCodeGoModels,
  resetOpenCodeGoCatalogForTests,
} from "../../open-sse/services/opencodeGoModels.js";

describe("opencode-go live catalog parser (shared v1/models + dashboard)", () => {
  beforeEach(() => resetOpenCodeGoCatalogForTests());

  it("passes every live id through, deduped, non-empty strings only", () => {
    const out = parseOpenCodeGoCatalog({
      object: "list",
      data: [
        { id: "glm-5.2" },
        { id: "kimi-k3" },
        { id: "gpt-5.6-luna" },
        { id: "glm-5.2" },
        { id: "" },
        { id: 123 },
        null,
        {},
      ],
    });
    expect(out.map((m) => m.id)).toEqual(["glm-5.2", "kimi-k3", "gpt-5.6-luna"]);
  });

  it("returns [] on malformed bodies", () => {
    expect(parseOpenCodeGoCatalog(null)).toEqual([]);
    expect(parseOpenCodeGoCatalog({})).toEqual([]);
    expect(parseOpenCodeGoCatalog({ data: null })).toEqual([]);
    expect(parseOpenCodeGoCatalog({ data: "nope" })).toEqual([]);
  });

  it("rejects overlong ids, control chars, and truncates long names", () => {
    expect(normalizeOpenCodeGoModel({ id: "a".repeat(300) })).toBeNull();
    expect(normalizeOpenCodeGoModel({ id: "bad\x01id" })).toBeNull();
    expect(normalizeOpenCodeGoModel({ id: "  glm-5.2  " })).toMatchObject({ id: "glm-5.2", name: "glm-5.2" });
    const long = normalizeOpenCodeGoModel({ id: "x", name: "n".repeat(600) });
    expect(long.name.length).toBe(512);
  });

  it("bounds input at 500 records", () => {
    const data = Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` }));
    expect(parseOpenCodeGoCatalog({ data }).length).toBe(500);
  });
});

describe("opencode-go resolver (production function)", () => {
  beforeEach(() => resetOpenCodeGoCatalogForTests());

  it("sends Bearer public (never the user apiKey) and returns models", async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push([url, opts]);
      return { ok: true, json: async () => ({ data: [{ id: "glm-5.2" }, { id: "kimi-k3" }] }) };
    };
    const result = await resolveOpenCodeGoModels({ fetchImpl });
    expect(result.models.map((m) => m.id)).toEqual(["glm-5.2", "kimi-k3"]);
    expect(seen[0][0]).toBe("https://opencode.ai/zen/go/v1/models");
    expect(seen[0][1].headers.Authorization).toBe("Bearer public");
  });

  it("fail-open to null on non-ok / throw (static seed serves)", async () => {
    expect(await resolveOpenCodeGoModels({ fetchImpl: async () => ({ ok: false }) })).toBeNull();
    resetOpenCodeGoCatalogForTests();
    expect(await resolveOpenCodeGoModels({ fetchImpl: async () => { throw new Error("down"); } })).toBeNull();
  });

  it("negative-caches failures briefly (no upstream hammering on outage)", async () => {
    let hits = 0;
    const fetchImpl = async () => {
      hits++;
      return { ok: false };
    };
    expect(await resolveOpenCodeGoModels({ fetchImpl })).toBeNull();
    expect(await resolveOpenCodeGoModels({ fetchImpl })).toBeNull();
    expect(hits).toBe(1);
  });

  it("caches success and dedups concurrent callers (one upstream hit)", async () => {
    let hits = 0;
    const fetchImpl = async () => {
      hits++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, json: async () => ({ data: [{ id: "glm-5.2" }] }) };
    };
    const [a, b] = await Promise.all([resolveOpenCodeGoModels({ fetchImpl }), resolveOpenCodeGoModels({ fetchImpl })]);
    expect(hits).toBe(1);
    expect(a.models.map((m) => m.id)).toEqual(["glm-5.2"]);
    expect(b.models.map((m) => m.id)).toEqual(["glm-5.2"]);
    // Second wave hits cache, no fetch.
    await resolveOpenCodeGoModels({ fetchImpl });
    expect(hits).toBe(1);
  });
});

describe("opencode-go suggested-models filter", () => {
  it("passes every live id through (no -free suffix filter)", async () => {
    const { FILTERS } = await import("../../src/app/api/providers/suggested-models/filters.js");
    const out = FILTERS["opencode-go"]([{ id: "glm-5.2" }, { id: "kimi-k3" }, { id: "" }]);
    expect(out.map((m) => m.id)).toEqual(["glm-5.2", "kimi-k3"]);
  });

  it("returns [] on non-array input", async () => {
    const { FILTERS } = await import("../../src/app/api/providers/suggested-models/filters.js");
    expect(FILTERS["opencode-go"](null)).toEqual([]);
    expect(FILTERS["opencode-go"]({})).toEqual([]);
  });
});
