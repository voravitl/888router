import { describe, it, expect } from "vitest";
import {
  buildCapsIndexes,
  classifyModelStatus,
  filterSyncModels,
  mergeCapsPreferFirst,
  normalizeSyncModel,
  partitionModelsByStatus,
  pickCaps,
  resolveModelCaps,
} from "@/shared/utils/modelCapsMerge";

const fallbackFor = () => ({
  vision: false,
  search: false,
  reasoning: false,
  contextWindow: undefined,
  maxOutput: 64000,
});

describe("UI model capability resolution", () => {
  it("keeps explicit false (not just true) as a stated capability", () => {
    expect(pickCaps({ vision: false, tools: true, search: undefined })).toEqual({
      vision: false,
      tools: true,
    });
    expect(mergeCapsPreferFirst({ vision: false }, { vision: true })).toEqual({ vision: false });
  });

  it("ingests dynamicCapsByKey under every scoped key (canonical + alias)", () => {
    const { byFull } = buildCapsIndexes({
      dynamicCapsByKey: {
        "opencode-go/hy4-flash-free": { vision: true, tools: true, contextWindow: 262144 },
        "ocg/hy4-flash-free": { vision: true, tools: true, contextWindow: 262144 },
      },
      models: [],
    });
    expect(byFull["opencode-go/hy4-flash-free"].vision).toBe(true);
    expect(byFull["ocg/hy4-flash-free"].vision).toBe(true);
  });

  it("resolves ocg/hy4-flash-free as vision-capable from the scoped dynamic map", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: {
        "ocg/hy4-flash-free": { vision: true, reasoning: true, contextWindow: 262144 },
      },
      models: [],
    });
    const caps = resolveModelCaps({ key: "ocg/hy4-flash-free", ...indexes, fallbackFor });
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(262144);
    // Nothing stated about tools → the fallback is allowed to fill it.
    expect(caps.maxOutput).toBe(64000);
  });

  it("finds an alias-scoped dynamic cap from the canonical provider key", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: {
        "ocg/hy4-flash-free": { vision: true },
      },
      models: [],
    });
    const caps = resolveModelCaps({
      key: "opencode-go/hy4-flash-free",
      aliasKey: "ocg/hy4-flash-free",
      ...indexes,
      fallbackFor,
    });
    expect(caps.vision).toBe(true);
  });

  it("reads model-row caps from data.models[].caps without a dynamicCapsByKey", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: {},
      models: [
        {
          fullModel: "ocg/hy4-flash-free",
          model: "hy4-flash-free",
          caps: { vision: true, reasoning: true, contextWindow: 1000000 },
        },
      ],
    });
    const caps = resolveModelCaps({ key: "ocg/hy4-flash-free", ...indexes, fallbackFor });
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
  });

  it("never lets a bare static id overwrite a scoped dynamic cap", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: {
        "opencode-go/hy4-flash-free": { vision: true },
      },
      models: [
        { fullModel: "opencode-go/hy4-flash-free", model: "hy4-flash-free", caps: { vision: false } },
      ],
    });
    expect(indexes.byFull["opencode-go/hy4-flash-free"].vision).toBe(true);
    const caps = resolveModelCaps({
      key: "opencode-go/hy4-flash-free",
      ...indexes,
      fallbackFor,
    });
    expect(caps.vision).toBe(true);
  });

  it("scopes one provider's model so it never bleeds into another provider's row", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: {
        "opencode-go/hy4-flash-free": { vision: true },
      },
      models: [],
    });
    const mine = resolveModelCaps({ key: "opencode-go/hy4-flash-free", ...indexes, fallbackFor });
    const other = resolveModelCaps({ key: "some-other-provider/hy4-flash-free", ...indexes, fallbackFor });
    expect(mine.vision).toBe(true);
    expect(other.vision).toBe(false);
  });

  it("lets explicit model-row caps outrank scoped dynamic caps and the fallback", () => {
    const indexes = buildCapsIndexes({
      dynamicCapsByKey: { "ocg/hy4-flash-free": { vision: true, reasoning: true } },
      models: [],
    });
    const caps = resolveModelCaps({
      key: "ocg/hy4-flash-free",
      modelOverride: { vision: false, maxOutput: 8192 },
      ...indexes,
      fallbackFor,
    });
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(true);
    expect(caps.maxOutput).toBe(8192);
  });
});

describe("Sync modal capability extraction and filters", () => {
  const rows = [
    normalizeSyncModel({
      id: "hy4-flash-free",
      name: "HY4 Flash",
      vision: true,
      tools: true,
      maxInputTokens: 262144,
      maxOutput: 65536,
      status: "active",
    }),
    normalizeSyncModel({
      id: "text-only",
      caps: { vision: false, reasoning: true, contextWindow: 128000 },
      description: "plain text",
    }),
    normalizeSyncModel({ id: "bare-model" }),
  ];

  it("preserves normalized caps and status from the upstream model row", () => {
    expect(rows[0]).toMatchObject({
      id: "hy4-flash-free",
      vision: true,
      tools: true,
      maxInputTokens: 262144,
      maxOutput: 65536,
      status: "active",
    });
    expect(rows[1]).toMatchObject({
      id: "text-only",
      vision: false,
      reasoning: true,
      contextWindow: 128000,
    });
  });

  it("Vision tab returns only models whose live caps say vision", () => {
    const vision = filterSyncModels(rows, { filterTab: "vision" });
    expect(vision.map((m) => m.id)).toEqual(["hy4-flash-free"]);
  });

  it("available / added tabs respect the existing-id set and combine with search", () => {
    expect(filterSyncModels(rows, { filterTab: "available", existingIds: ["hy4-flash-free"] })
      .map((m) => m.id)).toEqual(["text-only", "bare-model"]);
    expect(filterSyncModels(rows, { filterTab: "added", existingIds: ["hy4-flash-free"] })
      .map((m) => m.id)).toEqual(["hy4-flash-free"]);
    expect(filterSyncModels(rows, { query: "plain text" }).map((m) => m.id)).toEqual(["text-only"]);
  });

  it("normalizes string rows from a bare upstream list", () => {
    expect(normalizeSyncModel("just-an-id")).toEqual({ id: "just-an-id", name: "just-an-id" });
    expect(normalizeSyncModel(null)).toBeNull();
  });
});

describe("Live / synced / stale partitioning guard", () => {
  const buildRows = () => [
    { id: "hy4-flash-free", source: "synced", autoSynced: true },
    { id: "retired-model", source: "synced", autoSynced: true, missingSince: "2026-01-01T00:00:00.000Z" },
    { id: "my-own-model", source: "custom" },
    { id: "aliased-model", source: "legacyAlias" },
  ];

  it("marks nothing stale when the live catalog is empty or failed", () => {
    const liveIdSet = new Set();
    const rows = buildRows().map((row) => ({
      ...row,
      ...classifyModelStatus(row, { liveIdSet, hasLiveCatalog: false, missingSince: "now" }),
    }));
    expect(rows.every((row) => row.status === "active")).toBe(true);
    expect(rows.every((row) => row.missingSince === null)).toBe(true);
    expect(partitionModelsByStatus(rows).stale).toHaveLength(0);
  });

  it("stales only auto-synced rows absent from a non-empty live catalog", () => {
    const liveIdSet = new Set(["hy4-flash-free", "my-own-model"]);
    const rows = buildRows().map((row) => ({
      ...row,
      ...classifyModelStatus(row, {
        liveIdSet,
        hasLiveCatalog: true,
        missingSince: "2026-02-01T00:00:00.000Z",
      }),
    }));

    const { active, stale } = partitionModelsByStatus(rows);
    expect(active.map((row) => row.id)).toEqual(["hy4-flash-free", "my-own-model", "aliased-model"]);
    expect(stale.map((row) => row.id)).toEqual(["retired-model"]);
    expect(stale[0].missingSince).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps an explicitly user-created row active even when the upstream dropped it", () => {
    const row = { id: "my-own-model", source: "custom" };
    const result = classifyModelStatus(row, {
      liveIdSet: new Set(),
      hasLiveCatalog: true,
      missingSince: "now",
    });
    expect(result).toEqual({ status: "active", missingSince: null });
  });

  it("honours an explicit upstream stale status and stamps a missingSince", () => {
    const result = classifyModelStatus(
      { id: "retired-model", source: "synced", status: "stale" },
      { liveIdSet: new Set(["retired-model"]), hasLiveCatalog: true, missingSince: "2026-03-01T00:00:00.000Z" }
    );
    expect(result.status).toBe("stale");
    expect(result.missingSince).toBe("2026-03-01T00:00:00.000Z");
  });

  it("CAPACITY_META exposes multimodal badge metadata for vision, pdf, audioInput, videoInput, reasoning", async () => {
    const { CAPACITY_META } = await import("../../src/shared/constants/models.js");
    expect(CAPACITY_META.vision).toBeDefined();
    expect(CAPACITY_META.pdf).toBeDefined();
    expect(CAPACITY_META.audioInput).toBeDefined();
    expect(CAPACITY_META.videoInput).toBeDefined();
    expect(CAPACITY_META.reasoning).toBeDefined();
  });
});
