import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTA_SNAPSHOT_MAX_AGE_MS } from "open-sse/services/quotaSnapshot.js";
import {
  isAccountQualityFailure,
  updateHealthEma,
  computeScore,
  pickByScore,
  LATENCY_REF_MS_PER_TOKEN,
} from "open-sse/services/accountScoring.js";

describe("isAccountQualityFailure", () => {
  it.each([
    [401, true],
    [403, true],
    [429, true],
    [500, true],
    [503, true],
    [null, true],
    [undefined, true],
    [400, false],
    [404, false],
    [422, false],
  ])("status=%s -> %s", (status, expected) => {
    expect(isAccountQualityFailure(status, "some error")).toBe(expected);
  });
});

describe("updateHealthEma", () => {
  it("(a) fresh connection, success with latency+tokens -> hand-computed EMA fields", () => {
    const result = updateHealthEma({}, { ok: true, latencyMs: 300, outputTokens: 100 });
    // successEwma = 0.15*1 + 0.85*1.0 = 1.0 (cold start)
    expect(result.successEwma).toBeCloseTo(1.0, 10);
    // rawSample = 300/100 = 3; no existing EMA -> baseline = LATENCY_REF_MS_PER_TOKEN (15)
    // latEwmaPerTokenMs = 0.20*3 + 0.80*15 = 12.6
    expect(result.latEwmaPerTokenMs).toBeCloseTo(12.6, 10);
    expect(result.healthSamples).toBe(1);
    expect(typeof result.healthUpdatedAt).toBe("string");
    expect(new Date(result.healthUpdatedAt).toString()).not.toBe("Invalid Date");
  });

  it("(b) existing connection on failure -> successEwma moves toward 0, latEwmaPerTokenMs untouched", () => {
    const connection = { successEwma: 0.8, latEwmaPerTokenMs: 20, healthSamples: 5, healthUpdatedAt: new Date(Date.now() - 1000).toISOString() };
    const result = updateHealthEma(connection, { ok: false, latencyMs: 999 });
    // successEwma = 0.15*0 + 0.85*0.8 = 0.68
    expect(result.successEwma).toBeCloseTo(0.68, 10);
    expect(result.healthSamples).toBe(6);
    expect(result.latEwmaPerTokenMs).toBeUndefined();
  });

  it("(c) latency spike far above 1.5x existing EMA is clamped, not applied raw", () => {
    const connection = { latEwmaPerTokenMs: 10, healthUpdatedAt: new Date(Date.now() - 5000).toISOString() };
    const result = updateHealthEma(connection, { ok: true, latencyMs: 10000, outputTokens: 10 });
    // rawSample = 1000, clamp cap = 10*1.5=15 -> sample=15
    // latEwmaPerTokenMs = 0.20*15 + 0.80*10 = 11 (NOT 0.20*1000+0.80*10=208)
    expect(result.latEwmaPerTokenMs).toBeCloseTo(11, 10);
    expect(result.latEwmaPerTokenMs).not.toBeCloseTo(208, 0);
  });

  it("(d) staleness decay pulls old EMA toward the reference constant before blending", () => {
    const connection = { latEwmaPerTokenMs: 100, healthUpdatedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() };
    const result = updateHealthEma(connection, { ok: true, latencyMs: 500, outputTokens: 100 });
    // idle=90min -> stalenessFactor=min(90/60,1)=1 -> decayed = 100*(1-1)+15*1 = 15 (fully reverted)
    // rawSample = 500/100=5 (< 15*1.5=22.5, no clamp) -> ema = 0.20*5 + 0.80*15 = 13
    expect(result.latEwmaPerTokenMs).toBeCloseTo(13, 10);
    // Sanity: if decay had NOT applied, baseline would stay 100 -> 0.2*5+0.8*100=81, far from 13
    expect(result.latEwmaPerTokenMs).not.toBeCloseTo(81, 0);
  });

  it("(e) called with a genuinely missing/edge-case ok field is a graceful no-op", () => {
    expect(updateHealthEma({ successEwma: 0.5 }, {})).toEqual({});
    expect(updateHealthEma({ successEwma: 0.5 })).toEqual({});
    expect(updateHealthEma({ successEwma: 0.5 }, { ok: null, latencyMs: 100 })).toEqual({});
  });
});

describe("computeScore", () => {
  it("(a) totally fresh connection -> Q=1, S=1, L=1, score=1.0", () => {
    const result = computeScore({});
    expect(result.Q).toBe(1);
    expect(result.S).toBe(1);
    expect(result.L).toBe(1);
    expect(result.score).toBeCloseTo(1.0, 10);
  });

  it("(b) fresh low quota + healthy success/latency -> hand-computed score", () => {
    const now = Date.now();
    const connection = {
      quotaRemainingPct: 20,
      quotaCheckedAt: new Date(now).toISOString(),
      successEwma: 0.9,
      latEwmaPerTokenMs: LATENCY_REF_MS_PER_TOKEN, // rawL = 1/(1+1) = 0.5
      healthSamples: 10,
    };
    const result = computeScore(connection, now);
    expect(result.Q).toBeCloseTo(0.2, 10);
    expect(result.S).toBeCloseTo(0.9, 10);
    expect(result.L).toBeCloseTo(0.5, 10);
    // score = 0.5*0.2 + 0.35*0.9 + 0.15*0.5 = 0.49
    expect(result.score).toBeCloseTo(0.49, 10);
  });

  it("(c) confidence ramp at 5 healthSamples blends S (not fully raw, not fully neutral)", () => {
    const result = computeScore({ healthSamples: 5, successEwma: 0.2 });
    // confidence = 5/10 = 0.5 -> S = 0.5*0.2 + 0.5*1.0 = 0.6
    expect(result.S).toBeCloseTo(0.6, 10);
    expect(result.S).not.toBeCloseTo(0.2, 10);
    expect(result.S).not.toBeCloseTo(1.0, 10);
  });

  it("(d) stale quotaCheckedAt falls back Q to 1.0 even with a low quotaRemainingPct", () => {
    const now = Date.now();
    const stale = new Date(now - QUOTA_SNAPSHOT_MAX_AGE_MS - 1000).toISOString();
    const result = computeScore({ quotaRemainingPct: 5, quotaCheckedAt: stale }, now);
    expect(result.Q).toBe(1);
  });
});

describe("pickByScore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) hysteresis keeps the current pick when within 0.08 of the max score", () => {
    const current = { id: "cur", successEwma: 0.85, healthSamples: 10 }; // score = 0.9475
    const better = { id: "better", successEwma: 1.0, healthSamples: 10 }; // score = 1.0
    const result = pickByScore([current, better], { currentPickId: "cur" });
    expect(result.connection.id).toBe("cur");
    expect(result.breakdown.reason).toContain("sticky");
  });

  it("(b) no hysteresis and no epsilon draw picks the max-score candidate", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // >= EPSILON(0.10) -> no explore
    const low = { id: "low", successEwma: 0.1, healthSamples: 10 };
    const high = { id: "high", successEwma: 1.0, healthSamples: 10 };
    const result = pickByScore([low, high], { currentPickId: null });
    expect(result.connection.id).toBe("high");
    expect(result.breakdown.reason).toContain("best");
  });

  it("(c) epsilon draw triggers and picks from within the near-best band", () => {
    // 1st Math.random() call: explore check (< 0.10 triggers explore)
    // 2nd Math.random() call: index pick within the near-band array
    vi.spyOn(Math, "random").mockReturnValueOnce(0.01).mockReturnValueOnce(0);
    const far = { id: "far", successEwma: 0.0, healthSamples: 10 }; // well outside the 0.05 near-band
    const a = { id: "a", successEwma: 1.0, healthSamples: 10 }; // max score
    const b = { id: "b", successEwma: 0.98, healthSamples: 10 }; // within 0.05 of max
    const result = pickByScore([far, a, b], { currentPickId: null });
    // near-band = [a, b] (far excluded); index 0 -> "a"
    expect(["a", "b"]).toContain(result.connection.id);
    expect(result.connection.id).toBe("a");
    expect(result.breakdown.reason).toContain("explore");
  });

  it("(d) exact score tie breaks by lowest consecutiveUseCount", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no explore
    const x = { id: "x", consecutiveUseCount: 3, lastUsedAt: "2024-01-01T00:00:00.000Z" };
    const y = { id: "y", consecutiveUseCount: 1, lastUsedAt: "2024-01-02T00:00:00.000Z" };
    const result = pickByScore([x, y], { currentPickId: null });
    expect(result.connection.id).toBe("y");
  });

  it("(d) exact score tie with equal consecutiveUseCount breaks by oldest lastUsedAt (missing sorts oldest)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no explore
    const noLastUsed = { id: "no-last-used", consecutiveUseCount: 0 };
    const recent = { id: "recent", consecutiveUseCount: 0, lastUsedAt: "2024-06-01T00:00:00.000Z" };
    const result = pickByScore([recent, noLastUsed], { currentPickId: null });
    expect(result.connection.id).toBe("no-last-used");
  });

  it("returns { connection: null, breakdown: null } for an empty candidate array", () => {
    const result = pickByScore([], { currentPickId: null });
    expect(result).toEqual({ connection: null, breakdown: null });
  });
});

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

describe("getProviderCredentials weighted strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "weighted" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("picks the higher-scoring connection under the weighted strategy", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no epsilon exploration
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-a",
        provider: "claude",
        authType: "oauth",
        priority: 1,
        isActive: true,
        successEwma: 0.5,
        latEwmaPerTokenMs: 30,
        healthSamples: 10,
      },
      {
        id: "conn-b",
        provider: "claude",
        authType: "oauth",
        priority: 2,
        isActive: true,
        successEwma: 0.95,
        latEwmaPerTokenMs: 10,
        healthSamples: 10,
      },
    ]);

    const result = await getProviderCredentials("claude");

    expect(result.connectionId).toBe("conn-b");
  });
});
