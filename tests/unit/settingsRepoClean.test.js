import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-settings-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("settingsRepo schema and cleanup verification", () => {
  it("provides clean defaults without obsolete keys", async () => {
    const settings = await db.getSettings();

    // Verify non-obsolete default settings exist
    expect(settings.rtkEnabled).toBe(true);
    expect(settings.prunerEnabled).toBe(true);
    expect(settings.universalToolsMode).toBe("auto");
    expect(settings.authMode).toBe("password");
    expect(settings.stickyRoundRobinLimit).toBe(3);

    // Verify obsolete/stale keys have been removed
    expect(settings.pxpipeEnabled).toBeUndefined();
    expect(settings.pxpipeAutoInstall).toBeUndefined();
    expect(settings.pxpipeMinChars).toBeUndefined();
    expect(settings.pxpipeTimeoutMs).toBeUndefined();
    expect(settings.tunnelProvider).toBeUndefined();
    expect(settings.quotaVisibility).toBeUndefined();
  });

  it("merges updates and persists correctly", async () => {
    const updated = await db.updateSettings({ rtkEnabled: false });
    expect(updated.rtkEnabled).toBe(false);

    const reloaded = await db.getSettings();
    expect(reloaded.rtkEnabled).toBe(false);
  });
});
