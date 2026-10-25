import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the 2026-10-25 combo outage.
//
// A combo capped every member's own `timeoutMs` at a flat 10s:
//
//   isCombo ? Math.min(this.config.timeoutMs, 10000) : this.config.timeoutMs
//
// ollama declares 30s (a cloud model needs that long to prefill). The cap
// silently overrode that, so a HEALTHY member aborted at 10.2s:
//
//   [PENDING] END (ERROR) | provider=ollama | model=minimax-m3.1-flash
//   [ERROR] [502]: fetch connect timeout
//
// while the same upstream answered 1.4–7.7s from the same container (measured
// with 6 concurrent calls; 1.4s idle). The 9-free combo reported
// "All models failed" with a working model in it.
//
// The cap must remain a CEILING on provider-declared timeouts (a stuck member
// may not stall the whole combo) but never a FLOOR under the request policy,
// which already decides how long this request may wait.

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { COMBO_CONNECT_TIMEOUT_CAP_MS } = await import("../../open-sse/config/runtimeConfig.js");

function res(status) {
  return { status, headers: { get: () => "" }, text: async () => "" };
}

// The connect timer is the only setTimeout that receives an AbortSignal-driving
// callback we can name; capture every delay and assert on the set.
function captureTimeouts() {
  const delays = [];
  const orig = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...rest) => {
    delays.push(ms);
    return orig(fn, ms, ...rest);
  });
  return { delays, spy };
}

const creds = { apiKey: "k" };
const smallBody = { messages: [{ role: "user", content: "say hi" }] };
// >= 100k estimated tokens → the request policy switches to longContext.
const longBody = { messages: [{ role: "user", content: "a".repeat(500_000) }] };

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("combo connect timeout — provider timeoutMs is a ceiling, not a floor", () => {
  it("gives a 30s provider 20s inside a combo, not 10s", async () => {
    // ollama's declared timeoutMs is 30000.
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api", timeoutMs: 30000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    expect(delays).toContain(COMBO_CONNECT_TIMEOUT_CAP_MS);
    expect(delays).not.toContain(10000);
  });

  it("does not shrink a provider timeout below the request policy floor", async () => {
    const ex = new BaseExecutor("quick", { baseUrl: "https://x/api", timeoutMs: 4000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    // 4000 is under the cap → honoured as-is; the floor (10s policy) wins
    // because waiting less than the policy allows is never useful.
    expect(delays).toContain(10000);
  });

  it("honours the provider's full timeout outside a combo", async () => {
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api", timeoutMs: 30000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds });

    expect(delays).toContain(30000);
  });

  it("still gives long-context requests their larger budget", async () => {
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api", timeoutMs: 30000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: longBody, stream: false, credentials: creds, isCombo: true });

    // Policy longWait is >= 180s and must win over the 20s combo cap.
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(180000);
  });

  it("still falls back to the request policy when the provider declares no timeout", async () => {
    const ex = new BaseExecutor("plain", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    expect(delays).toContain(10000);
  });
});
