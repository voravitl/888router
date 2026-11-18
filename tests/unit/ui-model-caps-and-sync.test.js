import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PropTypes from "prop-types";
import { transformWithOxc } from "vite";
import { fullModelWithSuffix } from "@/shared/utils/claudeCodeModelId";
import { compareModels } from "@/app/(dashboard)/dashboard/providers/[id]/models-table-sort";
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

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");

async function loadModelsTableModule() {
  const filePath = resolve(repoRoot, "src/app/(dashboard)/dashboard/providers/[id]/ModelsTable.js");
  const raw = readFileSync(filePath, "utf8");
  const { code } = await transformWithOxc(raw, "ModelsTable.jsx", {
    jsx: { runtime: "classic" },
  });

  const body = code
    .replace(/^\s*["']use client["'];?\s*/m, "")
    .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "")
    .replace(/\bexport\s+default\s+function\s+/g, "function ")
    .replace(/\bexport\s+function\s+/g, "function ");

  const CapacityBadges = () => null;
  const SortIcon = () => null;

  const factory = new Function(
    "React",
    "useMemo",
    "useState",
    "PropTypes",
    "CapacityBadges",
    "SortIcon",
    "fullModelWithSuffix",
    "compareModels",
    `${body}\nreturn { ModelsTable, getLatestSyncedAt, fmtRelative, fmtAbsolute, compareModels };`
  );

  return factory(
    React,
    useMemo,
    useState,
    PropTypes,
    CapacityBadges,
    SortIcon,
    fullModelWithSuffix,
    compareModels
  );
}

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

describe("ModelsTable latestSyncedAt indicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getLatestSyncedAt returns null for empty or invalid timestamps", async () => {
    const { getLatestSyncedAt } = await loadModelsTableModule();
    expect(getLatestSyncedAt(null)).toBeNull();
    expect(getLatestSyncedAt(undefined)).toBeNull();
    expect(getLatestSyncedAt([])).toBeNull();
    expect(getLatestSyncedAt([{ id: "a" }, { id: "b", lastSyncedAt: null }, { id: "c", lastSyncedAt: "not-a-date" }])).toBeNull();
  });

  it("getLatestSyncedAt picks the most recent valid lastSyncedAt across models", async () => {
    const { getLatestSyncedAt } = await loadModelsTableModule();
    const latest = getLatestSyncedAt([
      { id: "old", lastSyncedAt: "2026-10-01T10:00:00.000Z" },
      { id: "bad", lastSyncedAt: "invalid" },
      { id: "newest", lastSyncedAt: "2026-11-18T04:50:00.000Z" },
      { id: "mid", lastSyncedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(latest).toBe("2026-11-18T04:50:00.000Z");
  });

  it("fmtRelative and fmtAbsolute format relative intervals and reject invalid dates", async () => {
    const { fmtRelative, fmtAbsolute } = await loadModelsTableModule();
    const fixedNow = Date.parse("2026-11-18T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    expect(fmtRelative("")).toBe("");
    expect(fmtRelative("not-a-date")).toBe("");
    expect(fmtRelative("2026-11-18T11:59:35.000Z")).toBe("Just now");
    expect(fmtRelative("2026-11-18T11:45:00.000Z")).toBe("15m ago");
    expect(fmtRelative("2026-11-18T09:00:00.000Z")).toBe("3h ago");
    expect(fmtRelative("2026-11-10T00:00:00.000Z")).toBe(
      new Date("2026-11-10T00:00:00.000Z").toLocaleDateString()
    );

    expect(fmtAbsolute("")).toBe("");
    expect(fmtAbsolute("not-a-date")).toBe("");
    expect(fmtAbsolute("2026-11-18T11:45:00.000Z")).toBe(
      new Date("2026-11-18T11:45:00.000Z").toLocaleString()
    );
  });

  it("renders Synced relative badge with absolute title from latest model timestamp", async () => {
    const { ModelsTable, fmtAbsolute } = await loadModelsTableModule();
    const fixedNow = Date.parse("2026-11-18T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    const latestIso = "2026-11-18T11:55:00.000Z";
    const html = renderToStaticMarkup(
      React.createElement(ModelsTable, {
        models: [
          { id: "m1", name: "Model 1", fullModel: "openai/m1", lastSyncedAt: "2026-11-18T10:00:00.000Z" },
          { id: "m2", name: "Model 2", fullModel: "openai/m2", lastSyncedAt: latestIso },
          { id: "m3", name: "Model 3", fullModel: "openai/m3", status: "stale", lastSyncedAt: "2026-11-17T00:00:00.000Z" },
        ],
        onCopy: () => {},
      })
    );

    expect(html).toContain("3 models available");
    expect(html).toContain('data-testid="models-last-synced"');
    expect(html).toContain("Synced 5m ago");
    expect(html).toContain(`title="Last synced: ${fmtAbsolute(latestIso)}"`);
    expect(html).toContain("Show stale (1)");
  });

  it("omits models-last-synced badge when no models carry valid lastSyncedAt", async () => {
    const { ModelsTable } = await loadModelsTableModule();
    const html = renderToStaticMarkup(
      React.createElement(ModelsTable, {
        models: [
          { id: "m1", name: "Model 1", fullModel: "openai/m1" },
          { id: "m2", name: "Model 2", fullModel: "openai/m2", lastSyncedAt: null },
        ],
        onCopy: () => {},
      })
    );

    expect(html).toContain("2 models available");
    expect(html).not.toContain('data-testid="models-last-synced"');
    expect(html).not.toContain("Synced ");
  });
});

async function loadProvidersPageModule({ useStateImpl, useEffectImpl, notify, fetchImpl } = {}) {
  const filePath = resolve(repoRoot, "src/app/(dashboard)/dashboard/providers/page.js");
  const raw = readFileSync(filePath, "utf8");
  const { code } = await transformWithOxc(raw, "ProvidersPage.jsx", {
    jsx: { runtime: "classic" },
  });

  const body = code
    .replace(/^\s*["']use client["'];?\s*/m, "")
    .replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "")
    .replace(/\bexport\s+default\s+function\s+/g, "function ");

  const passthrough = (name) => {
    const Comp = ({ children, actions, toolbar }) =>
      React.createElement("div", { "data-comp": name }, actions, toolbar, children);
    return Comp;
  };
  const stubButton = ({ children, onClick, disabled, loading, ...rest }) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick,
        disabled: Boolean(disabled || loading),
        "data-loading": loading ? "true" : "false",
        "data-variant": rest.variant,
      },
      children
    );

  const AntTable = ({ columns = [], dataSource = [] }) =>
    React.createElement("div", { "data-comp": "AntTable", "data-rows": dataSource.length, "data-cols": columns.length });

  const factory = new Function(
    "React",
    "useState",
    "useEffect",
    "PropTypes",
    "Card",
    "CardSkeleton",
    "Badge",
    "Button",
    "Toggle",
    "PageHero",
    "Segmented",
    "AntInput",
    "Tag",
    "AntTable",
    "AntDrawer",
    "Switch",
    "ProviderIcon",
    "OAUTH_PROVIDERS",
    "APIKEY_PROVIDERS",
    "FREE_PROVIDERS",
    "FREE_TIER_PROVIDERS",
    "WEB_COOKIE_PROVIDERS",
    "OPENAI_COMPATIBLE_PREFIX",
    "ANTHROPIC_COMPATIBLE_PREFIX",
    "Link",
    "getErrorCode",
    "getRelativeTime",
    "useNotificationStore",
    "useHeaderSearchStore",
    "ModelAvailabilityBadge",
    "AddCompatibleModal",
    "fetch",
    `${body}\nreturn { ProvidersPage };`
  );

  return factory(
    React,
    useStateImpl || useState,
    useEffectImpl || (() => {}),
    PropTypes,
    passthrough("Card"),
    passthrough("CardSkeleton"),
    passthrough("Badge"),
    stubButton,
    passthrough("Toggle"),
    passthrough("PageHero"),
    passthrough("Segmented"),
    passthrough("AntInput"),
    passthrough("Tag"),
    AntTable,
    passthrough("AntDrawer"),
    passthrough("Switch"),
    passthrough("ProviderIcon"),
    { openai: { id: "openai", name: "OpenAI" } },
    {},
    {},
    {},
    {},
    "openai-compatible-",
    "anthropic-compatible-",
    passthrough("Link"),
    () => null,
    () => "",
    () => notify || { success: () => {}, warning: () => {}, error: () => {}, info: () => {} },
    (sel) => sel({ query: "", register: () => {}, unregister: () => {} }),
    passthrough("ModelAvailabilityBadge"),
    passthrough("AddCompatibleModal"),
    fetchImpl || globalThis.fetch
  );
}

describe("Unified model sync UI wiring", () => {
  it("providers catalog page renders Sync All Models in PageHero and Matrix toolbar and handles sync outcomes", async () => {
    const notify = {
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    };
    const fetchMock = vi.fn();

    const { ProvidersPage } = await loadProvidersPageModule({
      useStateImpl: (initial) => [initial === true ? false : initial, vi.fn()],
      notify,
      fetchImpl: fetchMock,
    });

    const html = renderToStaticMarkup(React.createElement(ProvidersPage));
    expect(html).toContain("Sync All Models");
    expect(html).toContain("Test OAuth");

    // Capture actual onClick handlers by walking the React element tree returned by ProvidersPage
    const syncHandlers = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const p = node.props;
      if (p) {
        if (typeof p.onClick === "function" && String(p.children || "").includes("Sync All Models")) {
          syncHandlers.push(p);
        }
        visit(p.actions);
        visit(p.toolbar);
        visit(p.children);
      }
    };

    const setSyncingCalls = [];
    const { ProvidersPage: HookedPage } = await loadProvidersPageModule({
      useStateImpl: (initial) => {
        const setter = vi.fn((val) => {
          if (typeof val === "boolean") setSyncingCalls.push(val);
        });
        return [initial === true ? false : initial, setter];
      },
      notify,
      fetchImpl: fetchMock,
    });
    visit(HookedPage());

    // Both PageHero Button (has loading/icon props) and Matrix toolbar button are wired
    expect(syncHandlers.length).toBe(2);
    const heroBtn = syncHandlers.find((p) => "loading" in p);
    const matrixBtn = syncHandlers.find((p) => !("loading" in p));
    expect(heroBtn).toBeDefined();
    expect(heroBtn).toMatchObject({ size: "sm", variant: "secondary", icon: "sync", loading: false, disabled: false });
    expect(matrixBtn).toBeDefined();
    expect(matrixBtn.disabled).toBe(false);

    // 1. Success path
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, syncedProviders: 3, totalModels: 42, results: [{ ok: true }] }),
    });
    await heroBtn.onClick();
    expect(fetchMock).toHaveBeenCalledWith("/api/models/sync", { method: "POST" });
    expect(notify.success).toHaveBeenCalledWith("Synced 3 providers (42 models)");
    expect(setSyncingCalls).toEqual([true, false]);

    // 2. Partial error path -> notify.warning
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        syncedProviders: 2,
        totalModels: 10,
        results: [{ provider: "openai", ok: true }, { provider: "anthropic", ok: false, error: "401" }],
      }),
    });
    await matrixBtn.onClick();
    expect(notify.warning).toHaveBeenCalledWith("Synced 2 providers (10 models) — 1 failed");

    // 3. HTTP error path -> notify.error
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Sync exploded" }),
    });
    await heroBtn.onClick();
    expect(notify.error).toHaveBeenCalledWith("Sync exploded");

    // 4. Network error path -> notify.error
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await heroBtn.onClick();
    expect(notify.error).toHaveBeenCalledWith("Failed to sync models: ECONNREFUSED");
  });

  it("providers catalog page guards against concurrent handleSyncAllModels clicks when syncingModels is true", async () => {
    const fetchMock = vi.fn();
    const { ProvidersPage } = await loadProvidersPageModule({
      useStateImpl: (initial) => {
        // Force loading=false, all other booleans=true (so syncingModels is true)
        if (initial === true) return [false, vi.fn()];
        if (initial === false) return [true, vi.fn()];
        return [initial, vi.fn()];
      },
      fetchImpl: fetchMock,
    });

    const syncHandlers = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      const p = node.props;
      if (p) {
        const text = Array.isArray(p.children) ? p.children.join("") : String(p.children || "");
        if (typeof p.onClick === "function" && (text.includes("Syncing") || text.includes("Sync All Models"))) {
          syncHandlers.push(p);
        }
        visit(p.actions);
        visit(p.toolbar);
        visit(p.children);
      }
    };
    visit(ProvidersPage());

    expect(syncHandlers.length).toBe(2);
    expect(syncHandlers.every((p) => p.disabled === true)).toBe(true);
    await syncHandlers[0].onClick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("provider detail page refreshes syncedMap after dynamic fetch, modal close, and adding synced models", () => {
    const providerDetailSrc = readFileSync(
      resolve(repoRoot, "src/app/(dashboard)/dashboard/providers/[id]/page.js"),
      "utf8"
    );

    const dynamicFetchMatch = providerDetailSrc.match(
      /fetch\(targetEndpoint[\s\S]*?\[connections,\s*providerId,\s*isCompatible,\s*fetchSyncedModels\]\)/
    );
    expect(dynamicFetchMatch).not.toBeNull();
    expect(dynamicFetchMatch[0]).toContain("fetchSyncedModels()");

    expect(providerDetailSrc).toMatch(
      /const handleAddSyncedModels[\s\S]*?await fetchAliases\(\);\s*await fetchSyncedModels\(\);/
    );
    expect(providerDetailSrc).toMatch(
      /onClose=\{\(\)\s*=>\s*\{\s*setShowSyncModels\(false\);\s*fetchSyncedModels\(\);\s*\}\}/
    );
  });
});
