import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The dashboard used to have one cache number and it counted the gateway's own
// response-cache replay (opt-in header), which is 0 on normal traffic. The real
// story — providers billing 99% of prompt tokens at the cached rate — was not
// reported anywhere. These pin the two counters apart.
let tempDir;
let repo;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-cache-"));
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
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function save(id, { status = "success", prompt = 1000, cached = 0, cacheHit = false } = {}) {
  await repo.saveRequestDetail({
    id, provider: "alitp-intl", model: "test-model", status,
    tokens: { prompt_tokens: prompt, completion_tokens: 10, cached_tokens: cached },
    cacheHit,
  });
}

async function summary() {
  await repo.flushRequestDetailsBuffer();
  return repo.getTokenSaveSummary({
    startDate: new Date(Date.now() - 864e5).toISOString(),
    endDate: new Date(Date.now() + 6e4).toISOString(),
    limit: 500,
  });
}

describe("token-save summary separates prompt cache from response cache", () => {
  it("reports the upstream cached-token ratio as promptCache", async () => {
    await save("a", { prompt: 1000, cached: 900 });
    await save("b", { prompt: 1000, cached: 950 });
    await save("c", { prompt: 1000, cached: 0 });
    const s = await summary();
    // 1850 of 3000 prompt tokens came from cache.
    expect(s.promptCache.promptTokens).toBe(3000);
    expect(s.promptCache.cachedTokens).toBe(1850);
    expect(s.promptCache.pctSaved).toBe(62);
    expect(s.promptCache.requestsWithCache).toBe(2);
    expect(s.promptCache.requests).toBe(3);
  });

  it("does not let a response-cache hit inflate the prompt-cache ratio", async () => {
    await save("d", { prompt: 1000, cached: 0, cacheHit: true });
    const s = await summary();
    expect(s.cache.hits).toBe(1);
    expect(s.cache.hitRate).toBe(100);
    // The prompt cache saw one request and reused none of it.
    expect(s.promptCache.pctSaved).toBe(0);
    expect(s.promptCache.requestsWithCache).toBe(0);
  });

  it("counts an \"empty\" stream row, which still billed the prompt", async () => {
    // streamingHandler writes status:"empty" for a content-less stream, but the
    // upstream billed the prompt (and may have cached it).
    await save("empty1", { status: "empty", prompt: 1000, cached: 900 });
    const s = await summary();
    expect(s.promptCache.requests).toBe(1);
    expect(s.promptCache.cachedTokens).toBe(900);
  });

  it("ignores failed and token-less rows", async () => {
    await save("e", { status: "error", prompt: 5000, cached: 5000 });
    await save("f", { status: "success", prompt: 0, cached: 0 });
    await save("g", { status: "success", prompt: 100, cached: 100 });
    const s = await summary();
    // Only row "g" counts, otherwise a dead row would drag the ratio to 0.
    expect(s.promptCache.requests).toBe(1);
    expect(s.promptCache.pctSaved).toBe(100);
  });

  it("never reports cached above prompt tokens", async () => {
    // Some providers over-report cached_tokens on a mixed request.
    await save("h", { prompt: 100, cached: 500 });
    const s = await summary();
    expect(s.promptCache.cachedTokens).toBeLessThanOrEqual(s.promptCache.promptTokens);
    expect(s.promptCache.pctSaved).toBeLessThanOrEqual(100);
  });
});