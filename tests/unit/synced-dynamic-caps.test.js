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
  it("returns synced caps keyed by bare model id, stripping updatedAt", async () => {
    await import("@/lib/db/driver.js");
    const { saveModelDynamicCapabilities, getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");

    await saveModelDynamicCapabilities("xai/grok-4.6", { contextWindow: 500000, vision: true });
    await saveModelDynamicCapabilities("grok-4.5", { contextWindow: 500000 });

    const map = await getAllModelDynamicCapabilities();
    expect(map.size).toBe(2);
    expect(map.get("grok-4.6").contextWindow).toBe(500000);
    // Base key is the bare id (split("/").pop()), matching getCapabilitiesForModel
    expect(map.get("grok-4.6").vision).toBe(true);
    expect(map.get("grok-4.5").contextWindow).toBe(500000);
    // Persistence timestamp is repo metadata — must not leak into capabilities
    for (const caps of map.values()) {
      expect(caps.updatedAt).toBeUndefined();
    }
  });

  it("is empty when nothing has been synced", async () => {
    const { getAllModelDynamicCapabilities } = await import("@/lib/db/index.js");
    const map = await getAllModelDynamicCapabilities();
    expect(map.size).toBe(0);
  });
});