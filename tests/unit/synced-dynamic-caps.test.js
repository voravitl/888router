// Verify the mechanism that makes provider sync the source of truth for model
// context windows: dynamic capabilities persisted to the DB by the
// {provider}/models sync endpoint are bulk-loaded back and overlay the static
// catalogue in /v1/models (live upstream > synced > static pattern).
//
// Regression guard: a freshly-synced model (e.g. xai grok-4.6 with 500k) must
// NOT fall back to the generic *grok-4* static pattern (256k). Without this
// mechanism, every new model needs a per-model pattern edit in
// open-sse/providers/capabilities.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-caps-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("getAllModelDynamicCapabilities", () => {
  it("returns synced caps keyed by provider:model, stripping updatedAt", async () => {
    await import("@/lib/db/driver.js");
    const { saveModelDynamicCapabilities, getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");

    await saveModelDynamicCapabilities("xai", "grok-4.6", { contextWindow: 500000, vision: true });
    await saveModelDynamicCapabilities("xai", "grok-4.5", { contextWindow: 500000 });

    const map = await getAllModelDynamicCapabilities();
    expect(map.size).toBe(2);
    // Keys are scoped provider:model — no cross-provider bleed.
    expect(map.get("xai:grok-4.6").contextWindow).toBe(500000);
    expect(map.get("xai:grok-4.6").vision).toBe(true);
    expect(map.get("xai:grok-4.5").contextWindow).toBe(500000);
    // Persistence timestamp is repo metadata — must not leak into capabilities
    for (const caps of map.values()) {
      expect(caps.updatedAt).toBeUndefined();
    }
  });

  it("drops rows whose contextWindow is not a positive finite number", async () => {
    const { saveModelDynamicCapabilities, getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");

    await saveModelDynamicCapabilities("prov", "bad-zero", { contextWindow: 0, vision: true });
    await saveModelDynamicCapabilities("prov", "bad-negative", { contextWindow: -500 });
    await saveModelDynamicCapabilities("prov", "bad-string", { contextWindow: "128000" });
    await saveModelDynamicCapabilities("prov", "good", { contextWindow: 500000 });

    const map = await getAllModelDynamicCapabilities();
    expect(map.size).toBe(1);
    expect(map.get("prov:good").contextWindow).toBe(500000);
  });

  it("scopes by provider — the same model id on two providers stays isolated", async () => {
    const { saveModelDynamicCapabilities, getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");

    await saveModelDynamicCapabilities("provider-a", "grok-4", { contextWindow: 300000 });
    await saveModelDynamicCapabilities("provider-b", "grok-4", { contextWindow: 131072 });

    const map = await getAllModelDynamicCapabilities();
    expect(map.get("provider-a:grok-4").contextWindow).toBe(300000);
    expect(map.get("provider-b:grok-4").contextWindow).toBe(131072);
  });

  it("is empty when nothing has been synced", async () => {
    const { getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");
    const map = await getAllModelDynamicCapabilities();
    expect(map.size).toBe(0);
  });
});