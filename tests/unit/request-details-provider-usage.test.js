import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir;
let repo;
let originalListeners;
const shutdownEvents = ["beforeExit", "SIGINT", "SIGTERM", "exit"];
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  originalListeners = new Map(shutdownEvents.map((event) => [event, new Set(process.listeners(event))]));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "888route-provider-usage-"));
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

async function persist(providerResponse) {
  await repo.saveRequestDetail({ id: "evidence", provider: "test-provider", model: "requested-alias",
    status: "success", providerResponse, tokens: { prompt_tokens: 500000 } });
  await repo.flushRequestDetailsBuffer();
  const { getAdapter } = await import("../../src/lib/db/driver.js");
  const db = await getAdapter();
  // Read the actual JSON persisted by the real repository, not a helper mock.
  return JSON.parse(db.get("SELECT data FROM requestDetails WHERE id = ?", ["evidence"]).data).providerResponse;
}

const usage = { input_tokens: 513123, output_tokens: 150, total_tokens: 513273,
  input_tokens_details: { cached_tokens: 500000 }, output_tokens_details: { reasoning_tokens: 100 }, estimated: false };

describe("persisted provider usage survives bounded response truncation", () => {
  it("retains exact Codex usage, cache details and identity behind large response metadata", async () => {
    const original = { id: "resp-real", model: "actual-codex-model", status: "completed",
      instructions: "large provider metadata ".repeat(1000), output: [{ type: "function_call", arguments: '{"nonce":"test"}' }], usage };
    const response = await persist(original);
    expect(response._truncated).toBe(true);
    expect(response._originalSize).toBeGreaterThan(15000);
    expect(response.usage).toEqual(usage);
    expect(response).toMatchObject({ id: "resp-real", model: "actual-codex-model", status: "completed" });
    expect(response.instructions).toBeUndefined();
    expect(response.output).toBeUndefined();
    expect(response._preview.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(5 * 1024);
    expect(original.usage).toEqual(usage);
  });

  it("retains native Gemini usageMetadata and modelVersion while removing large candidate text", async () => {
    const usageMetadata = { promptTokenCount: 513123, candidatesTokenCount: 50, thoughtsTokenCount: 100,
      totalTokenCount: 513273, cachedContentTokenCount: 500000 };
    const response = await persist({ modelVersion: "actual-gemini-model", candidates: [{ content: {
      parts: [{ text: "large answer ".repeat(2000) }] } }], usageMetadata });
    expect(response._truncated).toBe(true);
    expect(response.usageMetadata).toEqual(usageMetadata);
    expect(response.modelVersion).toBe("actual-gemini-model");
    expect(response.candidates).toBeUndefined();
    expect(response).not.toHaveProperty("usage");
  });

  it("preserves bounded wrapped Gemini CLI usage in its original envelope", async () => {
    const usageMetadata = { promptTokenCount: 513123, candidatesTokenCount: 50, thoughtsTokenCount: 100,
      totalTokenCount: 513273, cachedContentTokenCount: 500000 };
    const response = await persist({ response: { modelVersion: "actual-wrapped-model", usageMetadata,
      candidates: [{ content: { parts: [{ text: "large answer ".repeat(2000) }] } }] } });
    expect(response._truncated).toBe(true);
    expect(response.response).toEqual({ modelVersion: "actual-wrapped-model", usageMetadata });
    expect(response).not.toHaveProperty("usageMetadata");
  });

  it.each([undefined, { ...usage, estimated: true }, { input_tokens: 0, output_tokens: 0, total_tokens: 0 }])(
    "does not invent usage or remove estimate/zero provenance (%j)", async (reportedUsage) => {
      const response = await persist({ metadata: "x".repeat(20000), ...(reportedUsage && { usage: reportedUsage }) });
      expect(response._truncated).toBe(true);
      if (reportedUsage === undefined) expect(response).not.toHaveProperty("usage");
      else expect(response.usage).toEqual(reportedUsage);
    });

  it("bounds hostile usage extensions without retaining new credential strings or losing counters/estimated", async () => {
    const response = await persist({ output: "x".repeat(20000), usage: { ...usage,
      authorization: "Bearer sensitive-credential", provider_extension: "sensitive-credential".repeat(10000),
      input_tokens_details: { cached_tokens: 500000, authorization: "Bearer sensitive-credential",
        huge: { payload: "sensitive-credential".repeat(10000) } },
    } });
    expect(response.usage).toEqual(usage);
    expect(JSON.stringify(response.usage)).not.toContain("sensitive-credential");
    expect(JSON.stringify(response.usage).length).toBeLessThanOrEqual(1024);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(5 * 1024);
  });

  it.each(["true", 1, null, { payload: "untrusted provenance ".repeat(10000) }])(
    "omits usage evidence with nonboolean estimated provenance (%j)", async (estimated) => {
      const reportedUsage = { ...usage, estimated };
      const response = await persist({ metadata: "x".repeat(20000), usage: reportedUsage,
        response: { usageMetadata: { promptTokenCount: 513123, estimated } } });
      expect(response._truncated).toBe(true);
      expect(response).not.toHaveProperty("usage");
      expect(response.response?.usageMetadata).toBeUndefined();
      expect(JSON.stringify(response).length).toBeLessThanOrEqual(5 * 1024);
      expect(reportedUsage.estimated).toBe(estimated);
    });
});
