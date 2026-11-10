import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearComboKnownUnavailable,
  getComboKnownUnavailable,
  markComboKnownUnavailable,
  listComboLocks,
  handleComboChat,
  COMBO_WRAPPER_MAX_LOCK_MS,
} from "../../open-sse/services/combo.js";

beforeEach(() => clearComboKnownUnavailable());
afterEach(() => clearComboKnownUnavailable());

describe("comboKnownUnavailable: composite combo wrapper lock cap", () => {
  it("caps multi-day quota lock on composite combo wrapper (no '/') to COMBO_WRAPPER_MAX_LOCK_MS", () => {
    const horizon41h = Date.now() + 41 * 3600 * 1000;
    // Composite candidate without "/" e.g. "cc-sonnet"
    markComboKnownUnavailable("cc-sonnet", horizon41h, "long-quota");

    const lockedUntil = getComboKnownUnavailable("cc-sonnet");
    expect(lockedUntil).toBeGreaterThan(0);
    // Must be capped within 30 seconds, not 41 hours!
    expect(lockedUntil).toBeLessThanOrEqual(Date.now() + (COMBO_WRAPPER_MAX_LOCK_MS || 30_000) + 100);

    const locks = listComboLocks();
    const entry = locks.find((l) => l.model === "cc-sonnet");
    expect(entry).toBeDefined();
    // Reason must be downgraded from "long-quota" so recovery passes are not permanently blocked
    expect(entry.reason).toBe("transient");
  });

  it("does NOT cap multi-day quota lock on concrete provider models (with '/')", () => {
    const horizon41h = Date.now() + 41 * 3600 * 1000;
    // Concrete candidate with provider prefix e.g. "ag/claude-sonnet-5-5-high"
    markComboKnownUnavailable("ag/claude-sonnet-5-5-high", horizon41h, "long-quota");

    const lockedUntil = getComboKnownUnavailable("ag/claude-sonnet-5-5-high");
    expect(lockedUntil).toBe(horizon41h);

    const locks = listComboLocks();
    const entry = locks.find((l) => l.model === "ag/claude-sonnet-5-5-high");
    expect(entry).toBeDefined();
    expect(entry.reason).toBe("long-quota");
  });

  it("does NOT lock parent combo candidate 'cc-sonnet' for 41h when child fails with long quota", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const horizon41hIso = new Date(Date.now() + 41 * 3600 * 1000).toISOString();

    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "cc-sonnet") {
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Individual quota reached. Resets in 41h10m42s.",
              retryAfter: horizon41hIso,
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await handleComboChat({
      body: { model: "9-sonnet", messages: [{ role: "user", content: "hi" }] },
      models: ["cc-sonnet", "ocg/deepseek-v4.1-flash"],
      handleSingleModel,
      log,
      comboName: "9-sonnet",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);

    // cc-sonnet must NOT be locked for 41h in comboKnownUnavailable
    const ccSonnetLock = getComboKnownUnavailable("cc-sonnet");
    expect(ccSonnetLock).toBeLessThanOrEqual(Date.now() + (COMBO_WRAPPER_MAX_LOCK_MS || 30_000) + 100);
  });
});
