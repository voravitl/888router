import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  COMBO_ROTATION_STRATEGIES,
  clearComboHeadTimeoutCooldown,
  clearComboInFlightCounters,
  clearComboKnownUnavailable,
  clearComboStrategyRedirectCount,
  clearComboUnknownStrategyWarnings,
  getComboHeadTimeoutCooldown,
  getComboInflight,
  getComboKnownUnavailable,
  getComboStrategyRedirectCount,
  getRotatedModels,
  handleComboChat,
  markComboHeadTimeout,
  markComboKnownUnavailable,
  normalizePersistedStrategy,
  readComboQuotaByModel,
  readComboQuotaForModel,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("all four new selectors are registered in the engine", () => {
    for (const strategy of ["headroom", "cost-optimized", "least-used", "random"]) {
      expect(COMBO_ROTATION_STRATEGIES.has(strategy)).toBe(true);
    }
  });

  it("headroom starts with the candidate holding the most remaining quota", () => {
    const models = ["a/model-cheap", "b/model-pricey", "c/model-blind"];
    const quotaByModel = {
      "a/model-cheap": { pct: 20, checkedAt: new Date().toISOString() },
      "b/model-pricey": { pct: 90, checkedAt: new Date().toISOString() },
      // c/model-blind: no reading → scores unknown → sorts last
    };
    const ordered = getRotatedModels(models, "code-xhigh", "headroom", 1, null, { quotaByModel });
    expect(ordered[0]).toBe("b/model-pricey");
    expect(ordered).toContain("a/model-cheap");
    expect(ordered[ordered.length - 1]).toBe("c/model-blind");
  });

  it("headroom with no quota data keeps list order (fail-open)", () => {
    const models = ["provider/model-a", "provider/model-b"];
    expect(getRotatedModels(models, "code-xhigh", "headroom", 1, null, {})).toEqual(models);
  });

  it("headroom ignores stale snapshots", () => {
    clearComboUnknownStrategyWarnings();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = ["a/model-stale", "b/model-fresh"];
      const quotaByModel = {
        "a/model-stale": { pct: 99, checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
        "b/model-fresh": { pct: 10, checkedAt: new Date().toISOString() },
      };
      const ordered = getRotatedModels(models, "code-xhigh", "headroom", 1, null, { quotaByModel });
      expect(ordered[0]).toBe("b/model-fresh");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("cost-optimized sorts cheapest first and unpriced models last", () => {
    // claude-haiku-* pattern (1.00+5.00=6.00) < claude-sonnet-* (3.00+15.00=18.00);
    // a model with no pricing entry sorts after every priced one.
    const models = ["x/claude-sonnet-4-6", "x/claude-haiku-4-5-20251001", "x/zz-no-such-model-zzz"];
    const ordered = getRotatedModels(models, "code-xhigh", "cost-optimized");
    expect(ordered[0]).toBe("x/claude-haiku-4-5-20251001");
    expect(ordered[1]).toBe("x/claude-sonnet-4-6");
    expect(ordered[2]).toBe("x/zz-no-such-model-zzz");
  });

  it("least-used starts with the candidate carrying the fewest in-flight requests", () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c"];
    clearComboInFlightCounters();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ordered = getRotatedModels(models, "code-xhigh", "least-used", 1, null, {
        inflightByModel: { "provider/model-a": 3, "provider/model-b": 0, "provider/model-c": 1 },
      });
      expect(ordered[0]).toBe("provider/model-b");
      expect(ordered[1]).toBe("provider/model-c");
      expect(ordered[2]).toBe("provider/model-a");
    } finally {
      warnSpy.mockRestore();
      clearComboInFlightCounters();
    }
  });

  it("least-used with no counters keeps list order (fail-open)", () => {
    clearComboInFlightCounters();
    const models = ["provider/model-a", "provider/model-b"];
    expect(getRotatedModels(models, "code-xhigh", "least-used")).toEqual(models);
  });

  it("random picks a uniform in-list start per request and stays stateless", () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c", "provider/model-d"];
    const randomSpy = vi.spyOn(Math, "random");
    try {
      randomSpy.mockReturnValue(0.0);
      expect(getRotatedModels(models, "code-xhigh", "random")[0]).toBe("provider/model-a");
      randomSpy.mockReturnValue(0.5);
      expect(getRotatedModels(models, "code-xhigh", "random")[0]).toBe("provider/model-c");
      randomSpy.mockReturnValue(0.9999);
      expect(getRotatedModels(models, "code-xhigh", "random")[0]).toBe("provider/model-d");
      // Stateless: same draw twice → same head, no rotation pointer advances.
      randomSpy.mockReturnValue(0.25);
      const first = getRotatedModels(models, "code-xhigh", "random")[0];
      const second = getRotatedModels(models, "code-xhigh", "random")[0];
      expect(first).toBe(second);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("warns exactly once per process for an unknown strategy and normalizes to fallback", () => {
    clearComboUnknownStrategyWarnings();
    clearComboStrategyRedirectCount();
    const models = ["provider/model-a", "provider/model-b"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getRotatedModels(models, "combo-a", "no-such-strategy");
      getRotatedModels(models, "combo-b", "no-such-strategy");
      getRotatedModels(models, "combo-a", "another-unknown");
      const firstWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('"no-such-strategy"'));
      const secondWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('"another-unknown"'));
      expect(firstWarns).toHaveLength(1);
      expect(secondWarns).toHaveLength(1);
      expect(String(firstWarns[0][0])).toContain("using list order (fallback)");
      // Unknown strings degrade to list order, and the redirect is counted once each.
      expect(getRotatedModels(models, "combo-a", "no-such-strategy")).toEqual(models);
      expect(getComboStrategyRedirectCount()).toBe(2);
      // Implemented strategies (old 6 + new 4) warn never …
      expect(normalizePersistedStrategy("headroom", "combo-a")).toBe("headroom");
      // … while null/empty inputs are the plain default.
      expect(normalizePersistedStrategy(null)).toBe("fallback");
      expect(normalizePersistedStrategy("")).toBe("fallback");
      expect(normalizePersistedStrategy("fallback")).toBe("fallback");
      // `fusion` is dispatched upstream — normalization must not rewrite it.
      expect(normalizePersistedStrategy("fusion", "combo-a")).toBe("fusion");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for implemented strategies", () => {
    const models = ["provider/model-a", "provider/model-b"];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const strategy of ["fallback", "round-robin", "cache-optimized", "p2c", "reset-aware", "reset-window", "headroom", "cost-optimized", "least-used", "random"]) {
        getRotatedModels(models, "code-xhigh", strategy, 1, strategy === "cache-optimized" ? { messages: [] } : null);
      }
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("combo locked-head pre-skip", () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  // Minimal failing response with an optional Retry-After header.
  function makeFailure(status, message, retryAfterSeconds) {
    return {
      status,
      ok: false,
      statusText: message,
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase();
          if (key === "content-type") return "application/json";
          if (key === "retry-after" && retryAfterSeconds != null) return String(retryAfterSeconds);
          return null;
        },
      },
      clone: () => ({ json: async () => ({ error: { message } }) }),
    };
  }

  function makeSuccess() {
    return {
      status: 200,
      ok: true,
      statusText: "OK",
      headers: { get: () => "application/json" },
      clone: () => ({ json: async () => ({ choices: [{ message: { content: "hi" } }] }) }),
    };
  }

  afterEach(() => {
    clearComboHeadTimeoutCooldown();
    clearComboKnownUnavailable();
  });

  it("pre-skips a locked head without attempting it (attempt count drops by one)", async () => {
    clearComboKnownUnavailable();
    const models = ["a/locked", "b/healthy"];
    markComboKnownUnavailable("a/locked", Date.now() + 60_000);

    const handleSingleModel = vi.fn(async () => makeSuccess());
    const infos = [];
    const logging = { info: (...a) => infos.push(a.join(" ")), warn: () => {}, error: () => {} };
    const result = await handleComboChat({
      body: { model: "pre-skip-combo" },
      models,
      handleSingleModel,
      log: logging,
      comboName: "pre-skip-combo",
      comboStrategy: "fallback",
    });

    expect(result.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("b/healthy");
    expect(infos.some((m) => m.includes("known unavailable"))).toBe(true);
    expect(getComboKnownUnavailable("a/locked")).toBeGreaterThan(Date.now());
  });

  it("retries a model normally once its lock has expired", async () => {
    clearComboKnownUnavailable();
    const models = ["a/was-locked", "b/healthy"];
    // An already-passed instant is ignored — the model is immediately eligible.
    markComboKnownUnavailable("a/was-locked", Date.now() - 1000);
    expect(getComboKnownUnavailable("a/was-locked")).toBe(0);

    const handleSingleModel = vi.fn(async () => makeSuccess());
    const result = await handleComboChat({
      body: { model: "pre-skip-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "pre-skip-combo",
      comboStrategy: "fallback",
    });

    expect(result.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("a/was-locked");
  });

  it("records a Retry-After 429 lock so the next request pre-skips it", async () => {
    clearComboKnownUnavailable();
    const models = ["a/quota-hit", "b/healthy"];
    const handleSingleModel = vi.fn(async (_body, modelStr) =>
      modelStr === "a/quota-hit"
        ? makeFailure(502, "pool parked", 45)
        : makeSuccess(),
    );
    const first = await handleComboChat({
      body: { model: "pre-skip-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "pre-skip-combo",
      comboStrategy: "fallback",
    });
    expect(first.ok).toBe(true);
    expect(getComboKnownUnavailable("a/quota-hit")).toBeGreaterThan(Date.now());

    // Second request: head is still locked → skipped without an attempt.
    handleSingleModel.mockClear();
    const second = await handleComboChat({
      body: { model: "pre-skip-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "pre-skip-combo",
      comboStrategy: "fallback",
    });
    expect(second.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("b/healthy");
  });

  it("skipped candidates still count so the all-failed Retry-After stays honest", async () => {
    clearComboKnownUnavailable();
    const models = ["a/locked", "b/also-locked"];
    markComboKnownUnavailable("a/locked", Date.now() + 30_000);
    markComboKnownUnavailable("b/also-locked", Date.now() + 20_000);

    const handleSingleModel = vi.fn(async () => makeFailure(500, "boom"));
    const result = await handleComboChat({
      body: { model: "pre-skip-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "pre-skip-combo",
      comboStrategy: "fallback",
    });
    // Nothing was attempted, but both locks feed the verdict's Retry-After.
    expect(handleSingleModel).not.toHaveBeenCalled();
    expect(result.headers.get("Retry-After")).toBe("20");
  });

  it("readComboQuotaForModel picks the best active snapshot for a provider", async () => {
    const now = new Date().toISOString();
    const getConnections = vi.fn(async () => [
      { id: "c1", quotaRemainingPct: 20, quotaCheckedAt: now },
      { id: "c2", quotaRemainingPct: 80, quotaCheckedAt: now },
      { id: "c3", quotaRemainingPct: null, quotaCheckedAt: now },
    ]);
    const best = await readComboQuotaForModel("ag/some-model", getConnections);
    expect(getConnections).toHaveBeenCalledWith({ provider: "antigravity", isActive: true });
    expect(best.pct).toBe(80);
    expect(best.connectionId).toBe("c2");
  });

  it("readComboQuotaForModel returns null on stale data, no connections, or reader errors", async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleReader = async () => [{ id: "c1", quotaRemainingPct: 90, quotaCheckedAt: stale }];
    expect(await readComboQuotaForModel("ag/m", staleReader)).toBeNull();
    expect(await readComboQuotaForModel("ag/m", async () => [])).toBeNull();
    expect(await readComboQuotaForModel("ag/m", async () => { throw new Error("db down"); })).toBeNull();
    expect(await readComboQuotaForModel("no-slash-model", async () => [])).toBeNull();
  });

  it("readComboQuotaForModel treats a missing checkedAt as stale, not fresh-forever", async () => {
    const reader = async () => [{ id: "c1", quotaRemainingPct: 90 }];
    expect(await readComboQuotaForModel("ag/m", reader)).toBeNull();
  });

  it("readComboQuotaByModel groups by provider: one reader call per provider", async () => {
    const now = new Date().toISOString();
    const getConnections = vi.fn(async ({ provider }) => (
      provider === "antigravity"
        ? [{ id: "c1", quotaRemainingPct: 80, quotaCheckedAt: now }]
        : [{ id: "c2", quotaRemainingPct: 10, quotaCheckedAt: now }]
    ));
    const quotaByModel = await readComboQuotaByModel(
      ["ag/m1", "ag/m2", "cc/m3"], getConnections,
    );
    expect(getConnections).toHaveBeenCalledTimes(2);
    expect(getConnections).toHaveBeenCalledWith({ provider: "antigravity", isActive: true });
    expect(getConnections).toHaveBeenCalledWith({ provider: "claude", isActive: true });
    expect(quotaByModel["ag/m1"].pct).toBe(80);
    expect(quotaByModel["ag/m2"].pct).toBe(80);
    expect(quotaByModel["cc/m3"].pct).toBe(10);
  });

  it("readComboQuotaByModel fails open to {} when the reader throws", async () => {
    const quotaByModel = await readComboQuotaByModel(["ag/m1"], async () => { throw new Error("db down"); });
    expect(quotaByModel).toEqual({});
  });

  it("handleComboChat with headroom + getComboConnections starts with the highest-quota provider", async () => {
    clearComboKnownUnavailable();
    const now = new Date().toISOString();
    const getComboConnections = vi.fn(async ({ provider }) => (
      provider === "antigravity"
        ? [{ id: "c1", quotaRemainingPct: 90, quotaCheckedAt: now }]
        : [{ id: "c2", quotaRemainingPct: 10, quotaCheckedAt: now }]
    ));
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      seen.push(modelStr);
      return {
        status: 200, ok: true, statusText: "OK",
        headers: { get: () => "application/json" },
        clone: () => ({ json: async () => ({ choices: [{ message: { content: "hi" } }] }) }),
      };
    });
    const result = await handleComboChat({
      body: { model: "headroom-combo" },
      models: ["cc/low-quota-model", "ag/high-quota-model"],
      handleSingleModel,
      log,
      comboName: "headroom-combo",
      comboStrategy: "headroom",
      getComboConnections,
    });
    expect(result.ok).toBe(true);
    // One reader call per provider, then the high-quota candidate leads.
    expect(getComboConnections).toHaveBeenCalledTimes(2);
    expect(seen[0]).toBe("ag/high-quota-model");
  });

  it("handleComboChat headroom without a connections reader keeps list order (fail-open)", async () => {
    clearComboKnownUnavailable();
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      seen.push(modelStr);
      return {
        status: 200, ok: true, statusText: "OK",
        headers: { get: () => "application/json" },
        clone: () => ({ json: async () => ({ choices: [{ message: { content: "hi" } }] }) }),
      };
    });
    const result = await handleComboChat({
      body: { model: "headroom-combo" },
      models: ["cc/model-a", "ag/model-b"],
      handleSingleModel,
      log,
      comboName: "headroom-combo",
      comboStrategy: "headroom",
    });
    expect(result.ok).toBe(true);
    expect(seen[0]).toBe("cc/model-a");
  });

  it("long-quota text verdict parks the failed model AND jumped-over same-provider models", async () => {
    clearComboKnownUnavailable();
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      seen.push(modelStr);
      if (modelStr === "ag/first") {
        return new Response(
          JSON.stringify({ error: { message: "[antigravity/x] [429]: Individual quota reached. Resets in 80h25m39s." } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return {
        status: 200, ok: true, statusText: "OK",
        headers: { get: () => "application/json" },
        clone: () => ({ json: async () => ({ choices: [{ message: { content: "hi" } }] }) }),
      };
    });
    const result = await handleComboChat({
      body: { model: "quota-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["ag/first", "ag/second", "kr/third"],
      handleSingleModel,
      log,
      comboName: "quota-combo",
      comboStrategy: "fallback",
    });
    expect(result.ok).toBe(true);
    // Same-provider jump: ag/second never attempted this request …
    expect(seen).toEqual(["ag/first", "kr/third"]);
    // … and both ag models are parked for the next request.
    expect(getComboKnownUnavailable("ag/first")).toBeGreaterThan(Date.now());
    expect(getComboKnownUnavailable("ag/second")).toBeGreaterThan(Date.now());
    expect(getComboKnownUnavailable("kr/third")).toBe(0);
    clearComboKnownUnavailable();
  });

  it("in-flight counters settle back to zero after attempts", async () => {
    clearComboInFlightCounters();
    const models = ["provider/model-a", "provider/model-b"];
    const handleSingleModel = vi.fn(async () => makeSuccess());
    await handleComboChat({
      body: { model: "inflight-combo" },
      models,
      handleSingleModel,
      log,
      comboName: "inflight-combo",
      comboStrategy: "least-used",
    });
    expect(getComboInflight("provider/model-a")).toBe(0);
    expect(getComboInflight("provider/model-b")).toBe(0);
    clearComboInFlightCounters();
  });
});

describe("combo p2c distribution and total-budget break", () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  it("p2c biases toward the head of the list (min-of-two-samples)", () => {
    const models = ["h/a", "h/b", "h/c", "h/d"];
    const randomSpy = vi.spyOn(Math, "random");
    try {
      // idxA=0, idxB=3 → min 0 → head.
      randomSpy.mockReturnValueOnce(0.0).mockReturnValueOnce(0.9);
      expect(getRotatedModels(models, "p2c-dist", "p2c")[0]).toBe("h/a");
      // idxA=3, idxB=2 → min 2 → third.
      randomSpy.mockReturnValueOnce(0.9).mockReturnValueOnce(0.6);
      expect(getRotatedModels(models, "p2c-dist", "p2c")[0]).toBe("h/c");
      // Distribution over many draws: the head must win strictly more often
      // than the tail (min-of-two skew), proving this is p2c and not uniform.
      const wins = { 0: 0, 1: 0, 2: 0, 3: 0 };
      for (let n = 0; n < 400; n++) {
        const head = getRotatedModels(models, "p2c-dist", "p2c")[0];
        wins[models.indexOf(head)]++;
      }
      expect(wins[0]).toBeGreaterThan(wins[3]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("combo-wide total budget stops starting new candidates once exhausted", async () => {
    const previous = process.env.COMBO_TOTAL_BUDGET_MS;
    process.env.COMBO_TOTAL_BUDGET_MS = "10000"; // min clamp: 10s
    try {
      const models = ["a/slow", "b/never"];
      const fail = () => new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
      const handleSingleModel = vi.fn(async (_body, modelStr) => {
        if (modelStr === "a/slow") {
          // Burn the whole budget on the first candidate so the second never starts.
          await new Promise((r) => setTimeout(r, 11_000));
        }
        return fail();
      });
      const warnings = [];
      const logging = { info: () => {}, warn: (...a) => warnings.push(a.join(" ")), error: () => {} };
      const result = await handleComboChat({
        body: { model: "budget-combo" },
        models,
        handleSingleModel,
        log: logging,
        comboName: "budget-combo",
        comboStrategy: "fallback",
      });
      expect(handleSingleModel).toHaveBeenCalledTimes(1);
      expect(warnings.some((m) => m.includes("total time budget"))).toBe(true);
      // The first candidate's 500 verdict stands (lastStatus); the budget break
      // only prevents STARTING further candidates, it does not rewrite the verdict.
      expect(result.status).toBe(500);
    } finally {
      if (previous === undefined) delete process.env.COMBO_TOTAL_BUDGET_MS;
      else process.env.COMBO_TOTAL_BUDGET_MS = previous;
    }
  }, 30000);
});

describe("combo stream-head timeout cooldown", () => {
  afterEach(() => {
    clearComboHeadTimeoutCooldown();
  });

  it("parks a model for 30s after markComboHeadTimeout", () => {
    const before = Date.now();
    markComboHeadTimeout("provider/model-a");
    const until = getComboHeadTimeoutCooldown("provider/model-a");
    expect(until).toBeGreaterThan(before);
    expect(until - before).toBeLessThanOrEqual(30 * 1000);
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBe(0);
  });

  it("clearComboHeadTimeoutCooldown clears one model or all", () => {
    markComboHeadTimeout("provider/model-a");
    markComboHeadTimeout("provider/model-b");
    clearComboHeadTimeoutCooldown("provider/model-a");
    expect(getComboHeadTimeoutCooldown("provider/model-a")).toBe(0);
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBeGreaterThan(0);
    clearComboHeadTimeoutCooldown();
    expect(getComboHeadTimeoutCooldown("provider/model-b")).toBe(0);
  });
});

describe("combo modelError fallback rules", () => {
  it("classifies permanent model-level errors as modelError", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    const notSupported = checkFallbackError(400, "Model deepseek-v4-flash-free is not supported");
    expect(notSupported.shouldFallback).toBe(false);
    expect(notSupported.modelError).toBe(true);

    const notFoundText = checkFallbackError(400, "model not found");
    expect(notFoundText.shouldFallback).toBe(false);
    expect(notFoundText.modelError).toBe(true);

    const status404 = checkFallbackError(404, "Not Found");
    expect(status404.shouldFallback).toBe(false);
    expect(status404.modelError).toBe(true);

    // Standard rate limit should still be account fallback, not model error
    const rateLimit = checkFallbackError(429, "Rate limit exceeded");
    expect(rateLimit.shouldFallback).toBe(true);
    expect(rateLimit.modelError).toBeUndefined();
  });

  it("classifies Kiro MODEL_TEMPORARILY_UNAVAILABLE as a model-level error (not account fallback)", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    // Kiro 500 returns {"message":"...high load...","reason":"MODEL_TEMPORARILY_UNAVAILABLE"}
    // The executor already retries the 500 a couple times; account rotation is pointless
    // (the model is overloaded for everyone), so it must NOT mark accounts for fallback.
    const overloaded = checkFallbackError(500, '{"message":"Encountered unexpectedly high load when processing the request, please try again.","reason":"MODEL_TEMPORARILY_UNAVAILABLE"}');
    expect(overloaded.shouldFallback).toBe(false);
    expect(overloaded.modelError).toBe(true);
    expect(overloaded.cooldownMs).toBe(0);
  });

  it("classifies OpenCode ModelError and promotion has ended as model-level errors", async () => {
    const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

    const opencodeModelError = checkFallbackError(401, '{"type":"error","error":{"type":"ModelError","message":"Free promotion has ended for DeepSeek V4 Flash Free. You can continue using the model by subscribing to OpenCode Go - https://opencode.ai/go"}}');
    expect(opencodeModelError.shouldFallback).toBe(false);
    expect(opencodeModelError.modelError).toBe(true);
    expect(opencodeModelError.cooldownMs).toBe(0);

    const promotionEnded = checkFallbackError(400, "promotion has ended for this model");
    expect(promotionEnded.shouldFallback).toBe(false);
    expect(promotionEnded.modelError).toBe(true);
    expect(promotionEnded.cooldownMs).toBe(0);
  });
});
