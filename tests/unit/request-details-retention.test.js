import { describe, it, expect, vi, beforeEach } from "vitest";

// Verify the requestDetails retention is TIME-based (delete older than N days),
// not COUNT-based (keep newest N). The old COUNT-based pruning dropped records
// older than ~2 days, which made the 30d Savings report return the same data
// as 7d. This test asserts the DELETE uses a timestamp cutoff.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn((fn) => fn()),
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    get: mocks.get,
    all: mocks.all,
    run: mocks.run,
    transaction: mocks.transaction,
  })),
}));

// settingsRepo is imported lazily inside getObservabilityConfig; stub it so the
// config resolves deterministically (retentionDays from DEFAULT_SETTINGS).
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({
    enableObservability: true,
    observabilityMaxRecords: 1000,
    observabilityRetentionDays: 30,
    observabilityBatchSize: 20,
    observabilityFlushIntervalMs: 5000,
    observabilityMaxJsonSize: 5,
  })),
}));

import { saveRequestDetail } from "../../src/lib/db/repos/requestDetailsRepo.js";

describe("requestDetails time-based retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // saveRequestDetail flushes immediately when token-saver stats present
    mocks.get.mockReturnValue({ c: 0 });
    mocks.all.mockReturnValue([]);
    mocks.run.mockReturnValue({ changes: 0 });
  });

  it("deletes records older than retentionDays using a timestamp cutoff", async () => {
    await saveRequestDetail({
      id: "x",
      timestamp: new Date().toISOString(),
      model: "m",
      provider: "p",
      rtkStats: { bytesBefore: 100, bytesAfter: 50 },
    });
    // saveRequestDetail fires flushToDatabase() without awaiting it; give the
    // fire-and-forget flush a tick to run before asserting.
    await new Promise((r) => setTimeout(r, 50));

    // The retention DELETE must be time-based: WHERE timestamp < cutoff
    const deleteCall = mocks.run.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("delete from requestdetails") &&
      String(sql).toLowerCase().includes("timestamp")
    );
    expect(deleteCall).toBeTruthy();
    const [sql, params] = deleteCall;
    expect(sql).toMatch(/timestamp\s*<\s*\?/i);
    // cutoff param is an ISO timestamp ~30 days in the past
    const cutoff = new Date(params[0]).getTime();
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(60_000);
  });

  it("keeps a count cap as a safety net (ORDER BY timestamp ASC LIMIT delete)", async () => {
    // count > maxRecords → the count-based prune also runs
    mocks.get.mockReturnValue({ c: 1001 }); // > maxRecords 1000
    await saveRequestDetail({
      id: "y",
      timestamp: new Date().toISOString(),
      model: "m",
      provider: "p",
      rtkStats: { bytesBefore: 100, bytesAfter: 50 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const countDelete = mocks.run.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("order by timestamp asc")
    );
    expect(countDelete).toBeTruthy();
  });

  it("does not run the count prune when under maxRecords", async () => {
    mocks.get.mockReturnValue({ c: 500 }); // < maxRecords 1000
    await saveRequestDetail({
      id: "z",
      timestamp: new Date().toISOString(),
      model: "m",
      provider: "p",
      rtkStats: { bytesBefore: 100, bytesAfter: 50 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const countDelete = mocks.run.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes("order by timestamp asc")
    );
    expect(countDelete).toBeUndefined();
  });
});
