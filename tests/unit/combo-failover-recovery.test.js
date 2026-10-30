import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleComboChat,
  clearComboKnownUnavailable,
  clearComboHeadTimeoutCooldown,
  resolveComboRecoveryWaitMs,
} from "../../open-sse/services/combo.js";

describe("combo recovery pass for short transient rate-limits and 5xx", () => {
  let savedRecoveryWait;
  let savedTotalBudget;

  beforeEach(() => {
    savedRecoveryWait = process.env.COMBO_RECOVERY_WAIT_MS;
    savedTotalBudget = process.env.COMBO_TOTAL_BUDGET_MS;
    clearComboKnownUnavailable();
    clearComboHeadTimeoutCooldown();
  });

  afterEach(() => {
    if (savedRecoveryWait === undefined) delete process.env.COMBO_RECOVERY_WAIT_MS;
    else process.env.COMBO_RECOVERY_WAIT_MS = savedRecoveryWait;
    if (savedTotalBudget === undefined) delete process.env.COMBO_TOTAL_BUDGET_MS;
    else process.env.COMBO_TOTAL_BUDGET_MS = savedTotalBudget;
    clearComboKnownUnavailable();
    clearComboHeadTimeoutCooldown();
  });

  const makeOkResponse = (content = "recovered ok") =>
    new Response(
      JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("case 2: recovers and returns 200 from A on second pass when A has a ~150ms 429 rate-limit and B has a permanent 400 model error", async () => {
    process.env.COMBO_RECOVERY_WAIT_MS = "2000";
    const infoLogs = [];
    const log = {
      info: (...args) => infoLogs.push(args.join(" ")),
      warn: () => {},
      error: () => {},
    };

    let aCalls = 0;
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "cc/model-a") {
        aCalls++;
        if (aCalls === 1) {
          const retryIso = new Date(Date.now() + 150).toISOString();
          return new Response(
            JSON.stringify({ error: { message: "Rate limit exceeded" }, retryAfter: retryIso }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          );
        }
        return makeOkResponse("from A second pass");
      }
      // B: permanent 400 model error
      return new Response(
        JSON.stringify({ error: { message: "The model 'model-b' is not supported." } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await handleComboChat({
      body: { model: "test-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["cc/model-a", "cx/model-b"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("from A second pass");
    expect(aCalls).toBe(2);
    expect(handleSingleModel).toHaveBeenCalledTimes(3); // A(1), B(1), A(2)
    expect(infoLogs.some((l) => /\[COMBO\] Recovery pass: waiting \d+ms for cc\/model-a/.test(l))).toBe(true);
  });

  it("case 3: does not wait when A is permanent 400 and B is long quota (hours) — returns 429 in < 200ms while short transient candidate would recover", async () => {
    process.env.COMBO_RECOVERY_WAIT_MS = "2000";
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "cx/model-a") {
        return new Response(
          JSON.stringify({ error: { message: "The model 'model-a' is not supported." } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const longRetryIso = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
      return new Response(
        JSON.stringify({ error: { message: "Quota exceeded. Resets in 3h." }, retryAfter: longRetryIso }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "10800" } },
      );
    });

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { model: "test-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["cx/model-a", "ag/model-b"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(200);
    expect(res.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(resolveComboRecoveryWaitMs({ COMBO_RECOVERY_WAIT_MS: "2000" })).toBe(2000);
    expect(resolveComboRecoveryWaitMs({})).toBe(10000);
  });

  it("case 4: aborts recovery wait immediately on client signal -> returns 499 with no further upstream call", async () => {
    process.env.COMBO_RECOVERY_WAIT_MS = "2000";
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const abortCtrl = new AbortController();

    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "cc/model-a") {
        // Schedule client abort 40ms into the ~500ms recovery wait
        setTimeout(() => abortCtrl.abort(), 40);
        const retryIso = new Date(Date.now() + 500).toISOString();
        return new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded" }, retryAfter: retryIso }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "Model not supported" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { model: "test-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["cc/model-a", "cx/model-b"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
      signal: abortCtrl.signal,
    });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(499);
    expect(handleSingleModel).toHaveBeenCalledTimes(2); // Only first pass A and B, no second call to A
    expect(elapsed).toBeLessThan(300);
  });

  it("case 5: does not wait when recovery time exceeds COMBO_RECOVERY_WAIT_MS — verdict unchanged", async () => {
    process.env.COMBO_RECOVERY_WAIT_MS = "200";
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    let aCalls = 0;
    const handleSingleModel = vi.fn(async (_body, modelStr) => {
      if (modelStr === "cc/model-a") {
        aCalls++;
        if (aCalls === 1) {
          const retryIso = new Date(Date.now() + 1500).toISOString();
          return new Response(
            JSON.stringify({ error: { message: "Rate limit exceeded" }, retryAfter: retryIso }),
            { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "2" } },
          );
        }
        return makeOkResponse("should not be reached when wait > 200ms");
      }
      return new Response(
        JSON.stringify({ error: { message: "Model not supported" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    });

    const t0 = Date.now();
    const res = await handleComboChat({
      body: { model: "test-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["cc/model-a", "cx/model-b"],
      handleSingleModel,
      log,
      comboName: "test-combo",
      comboStrategy: "fallback",
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(150);
    expect(res.status).toBe(429);
    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(resolveComboRecoveryWaitMs({ COMBO_RECOVERY_WAIT_MS: "200" })).toBe(200);
  });
});
