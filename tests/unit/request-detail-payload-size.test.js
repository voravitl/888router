import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The persisted `_originalSize` is the only evidence an operator has that a
// request was dropped for size. It undercounted tool output to zero (Claude
// Code nests tool_result text in content[].text), so a 730k-token prompt was
// recorded as 102 KB and could not be diagnosed. These cases lock the counter
// to the real serialized size.

let tempDir;
let repo;
let originalListeners;
const shutdownEvents = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  originalListeners = new Map(shutdownEvents.map((event) => [event, new Set(process.listeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "888route-payload-size-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { updateSettings } = await import("../../src/lib/db/repos/settingsRepo.js");
  await updateSettings({ enableObservability: true, observabilityMaxJsonSize: 5 });
  repo = await import("../../src/lib/db/repos/requestDetailsRepo.js");
});

afterEach(async () => {
  await repo?.flushRequestDetailsBuffer();
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  for (const event of shutdownEvents) {
    for (const listener of process.listeners(event)) {
      if (!originalListeners.get(event).has(listener)) process.off(event, listener);
    }
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function persistRequest(request) {
  await repo.saveRequestDetail({ id: "evidence", provider: "test-provider", model: "test-model",
    status: "success", request, tokens: { prompt_tokens: 1000 } });
  await repo.flushRequestDetailsBuffer();
  const { getAdapter } = await import("../../src/lib/driver.js").catch(() => import("../../src/lib/db/driver.js"));
  const db = await getAdapter();
  return JSON.parse(db.get("SELECT data FROM requestDetails WHERE id = ?", ["evidence"]).data).request;
}

describe("dropped request payload is reported at its real size", () => {
  it("counts Claude Code tool_result text nested in content[].text", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "A".repeat(200000) }] },
    ] }] };
    const request = await persistRequest(body);
    // Was 0 before the fix, which serialized to {"_originalSize":0}.
    expect(request._truncated).toBe(true);
    expect(request._originalSize).toBe(JSON.stringify(body).length);
    expect(request._originalSize).toBeGreaterThan(200000);
  });

  it("does not stop counting at the old 64 KB ceiling", async () => {
    const body = { messages: [
      { role: "tool", content: [{ type: "text", text: "B".repeat(100000) }] },
      { role: "tool", content: [{ type: "text", text: "C".repeat(100000) }] },
    ] };
    const request = await persistRequest(body);
    expect(request._originalSize).toBe(JSON.stringify(body).length);
    expect(request._originalSize).toBeGreaterThan(200000);
  });

  it("reports base64 media at its real size instead of counting it as zero", async () => {
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64", data: "Q".repeat(400000) } },
    ] }] };
    const request = await persistRequest(body);
    expect(request._truncated).toBe(true);
    expect(request._originalSize).toBe(JSON.stringify(body).length);
  });

  it("leaves a small request intact", async () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const request = await persistRequest(body);
    expect(request).toEqual(body);
  });
});
