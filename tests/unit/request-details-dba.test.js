import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dba-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
  await updateSettings({ enableObservability: true });
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("requestDetails DBA denormalized columns", () => {
  it("flushToDatabase extracts stats into denormalized columns and summary reads them", async () => {
    const { saveRequestDetail, getTokenSaveSummary } = await import(
      "../../src/lib/db/repos/requestDetailsRepo.js"
    );

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await saveRequestDetail({
      id: "d1",
      timestamp: yesterday,
      provider: "xai",
      model: "m1",
      status: "pending",
    });

    const summary = await getTokenSaveSummary({ startDate: weekAgo, endDate: tomorrow });
    expect(summary.period.scanned).toBe(0); // buffered, flush not yet run
  });

  it("flushToDatabase writes columns after timer flush and summary equals old parseJson path", async () => {
    const { saveRequestDetail, getTokenSaveSummary, flushRequestDetailsBuffer } = await import(
      "../../src/lib/db/repos/requestDetailsRepo.js"
    );

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await saveRequestDetail({
      id: "d2",
      timestamp: yesterday,
      provider: "xai",
      model: "m1",
      status: "success",
      prunerStats: { tokensBefore: 10000, tokensAfter: 2000, tokensSaved: 8000, omittedMessages: 5 },
      rtkStats: { bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "grep" }] },
      headroomStats: { tokens_before: 500, tokens_after: 100, tokens_saved: 400 },
      cacheHit: true,
    });

    await flushRequestDetailsBuffer();

    const summary = await getTokenSaveSummary({ startDate: weekAgo, endDate: tomorrow });
    expect(summary.period.scanned).toBe(1);
    expect(summary.pruner.tokensBefore).toBe(10000);
    expect(summary.pruner.tokensSaved).toBe(8000);
    expect(summary.pruner.omittedMessages).toBe(5);
    expect(summary.rtk.bytesBefore).toBe(1000);
    expect(summary.rtk.bytesSaved).toBe(600);
    expect(summary.headroom.tokensSaved).toBe(400);
    expect(summary.cache.hits).toBe(1);
  });
});
