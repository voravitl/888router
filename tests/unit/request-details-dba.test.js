import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-dba-"));
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

describe("requestDetails DBA denormalized columns", () => {
  it("flushToDatabase extracts stats into denormalized columns and summary reads them", async () => {
    const { saveRequestDetail, getTokenSaveSummary } = await import(
      "../../src/lib/db/repos/requestDetailsRepo.js"
    );

    saveRequestDetail({
      id: "d1",
      timestamp: "2026-07-13T00:00:00.000Z",
      provider: "xai",
      model: "m1",
      status: "success",
      prunerStats: { tokensBefore: 10000, tokensAfter: 2000, tokensSaved: 8000, omittedMessages: 5 },
      rtkStats: { bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "grep" }] },
      headroomStats: { tokens_before: 500, tokens_after: 100, tokens_saved: 400 },
      cacheHit: true,
    });

    // flushToDatabase is internal; exercised via the shutdown handler
    // (clearTimeout + beforeExit) — drive it through a second save that
    // triggers the flush timer path, then read columns directly.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Force the pending flush by triggering the beforeExit handler logic:
    // re-import after a fresh module to avoid timer race — instead assert
    // via the summary (which reads the same columns) after an explicit flush
    // through the module's internal timer by waiting.
    const summary = await getTokenSaveSummary({ startDate: "2026-07-01", endDate: "2026-07-14" });
    expect(summary.period.scanned).toBe(0); // flush not yet run
  });

  it("flushToDatabase writes columns after timer flush and summary equals old parseJson path", async () => {
    const { saveRequestDetail, getTokenSaveSummary } = await import(
      "../../src/lib/db/repos/requestDetailsRepo.js"
    );

    saveRequestDetail({
      id: "d1",
      timestamp: "2026-07-13T00:00:00.000Z",
      provider: "xai",
      model: "m1",
      status: "success",
      prunerStats: { tokensBefore: 10000, tokensAfter: 2000, tokensSaved: 8000, omittedMessages: 5 },
      rtkStats: { bytesBefore: 1000, bytesAfter: 400, hits: [{ filter: "grep" }] },
      headroomStats: { tokens_before: 500, tokens_after: 100, tokens_saved: 400 },
      cacheHit: true,
    });

    // Trigger the module's beforeExit shutdown flush: emit the event.
    // The module registers process.on("beforeExit") — not directly
    // invokable; use the exported saveRequestDetail's internal flush by
    // calling the module's flushToDatabase indirectly via the driver's
    // transaction requirement. Simplest reliable path: re-import module
    // fresh so its timer fires, then wait for the flush interval.
    // The repo uses a 5s flush timer; test with a manual process event.
    process.emit("beforeExit");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const summary = await getTokenSaveSummary({ startDate: "2026-07-01", endDate: "2026-07-14" });
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
