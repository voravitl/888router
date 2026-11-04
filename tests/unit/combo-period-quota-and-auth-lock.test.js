// Regression (2026-11-04, 9-sonnet): ollama "monthly usage limit" 429 was parked
// only 5m and alitp "1-month quota ... reset at 12-03 16:00:00 UTC" only 30m, so
// every few minutes a request paid the dead hop again. 401 (no credential) hops
// in auto/best-free-1m were re-tried on every request as well.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePeriodQuotaLockMs,
  resolveAuthErrorCooldownMs,
  handleComboChat,
  getComboKnownUnavailable,
  clearComboKnownUnavailable,
} from "../../open-sse/services/combo.js";

beforeEach(() => clearComboKnownUnavailable());
afterEach(() => clearComboKnownUnavailable());

describe("parsePeriodQuotaLockMs", () => {
  const now = Date.UTC(2026, 10, 4, 13, 0, 0);

  it("honours 'reset at MM-DD HH:MM:SS UTC' but caps at 24h", () => {
    const ms = parsePeriodQuotaLockMs("The quota will reset at 12-03 16:00:00 UTC.", now);
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });

  it("uses the exact delta when the reset is within 24h", () => {
    const ms = parsePeriodQuotaLockMs("quota will reset at 11-04 18:00:00 UTC", now);
    expect(ms).toBe(5 * 60 * 60 * 1000);
  });

  it("locks 6h for a monthly limit with no date", () => {
    expect(parsePeriodQuotaLockMs("you have reached your monthly usage limit, upgrade", now)).toBe(6 * 60 * 60 * 1000);
  });

  it("returns null for ordinary rate limits", () => {
    expect(parsePeriodQuotaLockMs("Too many requests, slow down", now)).toBeNull();
    expect(parsePeriodQuotaLockMs("", now)).toBeNull();
  });
});

describe("resolveAuthErrorCooldownMs", () => {
  it("defaults to 30m and clamps env to 1m-6h", () => {
    expect(resolveAuthErrorCooldownMs({})).toBe(30 * 60 * 1000);
    expect(resolveAuthErrorCooldownMs({ COMBO_AUTH_ERROR_COOLDOWN_MS: "10" })).toBe(60 * 1000);
    expect(resolveAuthErrorCooldownMs({ COMBO_AUTH_ERROR_COOLDOWN_MS: "999999999" })).toBe(6 * 60 * 60 * 1000);
  });
});

describe("handleComboChat locks", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const ok = () => json(200, { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

  it("401 parks the model and its same-provider siblings for the next request", async () => {
    const seen = [];
    const handleSingleModel = async (_b, m) => {
      seen.push(m);
      return m.startsWith("kilo-gateway/") ? json(401, { error: { message: "no credential" } }) : ok();
    };
    const models = ["kilo-gateway/a:free", "kilo-gateway/b:free", "kr/claude"];
    const res = await handleComboChat({ body: { messages: [{ role: "user", content: "hi" }] }, models, handleSingleModel, log, comboName: "t", comboStrategy: "fallback" });
    expect(res.ok).toBe(true);
    expect(seen[0]).toBe("kilo-gateway/a:free");
    expect(getComboKnownUnavailable("kilo-gateway/a:free")).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
    expect(getComboKnownUnavailable("kilo-gateway/b:free")).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
    expect(getComboKnownUnavailable("kr/claude")).toBe(0);

    seen.length = 0;
    await handleComboChat({ body: { messages: [{ role: "user", content: "hi" }] }, models, handleSingleModel, log, comboName: "t", comboStrategy: "fallback" });
    expect(seen).toEqual(["kr/claude"]);
  });

  it("a monthly-limit 429 is locked far beyond the reported 5m", async () => {
    const handleSingleModel = async (_b, m) =>
      m.startsWith("ollama/")
        ? json(429, { error: "you have reached your monthly usage limit, upgrade for higher limits", retryAfter: new Date(Date.now() + 5 * 60 * 1000).toISOString() })
        : ok();
    const res = await handleComboChat({ body: { messages: [{ role: "user", content: "hi" }] }, models: ["ollama/x", "kr/claude"], handleSingleModel, log, comboName: "t", comboStrategy: "fallback" });
    expect(res.ok).toBe(true);
    expect(getComboKnownUnavailable("ollama/x")).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
  });
});

import {
  listComboLocks,
  unlockComboModel,
  markComboKnownUnavailable,
  markComboHeadTimeout,
  clearComboHeadTimeoutCooldown,
} from "../../open-sse/services/combo.js";

describe("combo lock list + unlock (UI backing)", () => {
  afterEach(() => clearComboHeadTimeoutCooldown());

  it("lists both lock kinds with reasons, soonest first", () => {
    markComboKnownUnavailable("ollama/x", Date.now() + 3600_000, "long-quota");
    markComboHeadTimeout("kr/slow", 30_000);
    const locks = listComboLocks();
    expect(locks.map((l) => [l.model, l.reason])).toEqual([
      ["kr/slow", "head-timeout"],
      ["ollama/x", "long-quota"],
    ]);
  });

  it("unlocks one model, then all", () => {
    markComboKnownUnavailable("a/1", Date.now() + 60_000, "auth");
    markComboKnownUnavailable("b/2", Date.now() + 60_000, "auth");
    unlockComboModel("a/1");
    expect(listComboLocks().map((l) => l.model)).toEqual(["b/2"]);
    unlockComboModel();
    expect(listComboLocks()).toEqual([]);
  });
});

import {
  escalatedPermanentLockMs,
  isDeadCredentialFailure,
  clearPermanentStrikes,
} from "../../open-sse/services/combo.js";

describe("dead-hop locks (#619)", () => {
  beforeEach(() => clearPermanentStrikes());

  it("escalates permanent locks 60s -> 120s -> ... capped at 1h", () => {
    expect(escalatedPermanentLockMs(60_000, 1)).toBe(60_000);
    expect(escalatedPermanentLockMs(60_000, 2)).toBe(120_000);
    expect(escalatedPermanentLockMs(60_000, 3)).toBe(240_000);
    expect(escalatedPermanentLockMs(60_000, 20)).toBe(3_600_000);
  });

  it("classifies missing-credential and local-config failures only", () => {
    expect(isDeadCredentialFailure(404, "No active credentials for provider: bazaarlink")).toBe(true);
    expect(isDeadCredentialFailure(502, "cloudflare-ai requires accountId in providerSpecificData")).toBe(true);
    expect(isDeadCredentialFailure(401, "")).toBe(true);
    expect(isDeadCredentialFailure(404, "Model not found")).toBe(false);
    expect(isDeadCredentialFailure(502, "Bad gateway")).toBe(false);
  });

  const log = { info: vi.fn(), warn: vi.fn() };
  const json = (status, message) =>
    new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });
  const ok = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("a no-credentials 404 locks the whole provider for 30m, not 60s", async () => {
    const handleSingleModel = async (_b, m) =>
      m.startsWith("bazaarlink/") ? json(404, "No active credentials for provider: bazaarlink") : ok();
    const models = ["bazaarlink/a", "bazaarlink/b", "kr/claude"];
    const res = await handleComboChat({ body: { messages: [{ role: "user", content: "hi" }] }, models, handleSingleModel, log, comboName: "t", comboStrategy: "fallback" });
    expect(res.ok).toBe(true);
    for (const m of ["bazaarlink/a", "bazaarlink/b"]) {
      expect(getComboKnownUnavailable(m)).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
    }
  });

  it("a local-config 502 locks the provider instead of retrying every request", async () => {
    const handleSingleModel = async (_b, m) =>
      m.startsWith("cloudflare-ai/") ? json(502, "cloudflare-ai requires accountId in providerSpecificData") : ok();
    const res = await handleComboChat({ body: { messages: [{ role: "user", content: "hi" }] }, models: ["cloudflare-ai/x", "kr/claude"], handleSingleModel, log, comboName: "t", comboStrategy: "fallback" });
    expect(res.ok).toBe(true);
    expect(getComboKnownUnavailable("cloudflare-ai/x")).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
  });
});
