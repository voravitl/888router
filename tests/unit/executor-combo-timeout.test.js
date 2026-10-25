import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the 2026-10-25 combo outage.
//
// Inside a combo the connect wait was a flat 10s AND it replaced the provider
// default with the request policy's 10s:
//
//   combo, provider declared 30s → min(30000, 10000) = 10s
//   combo, provider declared none → policy connectTimeoutMs = 10s
//   standalone, provider declared none → FETCH_CONNECT_TIMEOUT_MS = 60s
//
// ollama declares NO top-level timeoutMs (the 30s in its registry entry is the
// web-fetch config), so a direct call gets 60s and a combo member got 10s — a
// sixth of its standalone patience. A HEALTHY member aborted at 10.2s:
//
//   [PENDING] END (ERROR) | provider=ollama | model=minimax-m3.1-flash
//   [ERROR] [502]: fetch connect timeout
//
// while the same upstream answered 1.4–7.7s idle and longer under 6 concurrent
// calls. The 9-free combo reported "All models failed" with a working model in
// it. Confirmed again on 0.15.190, whose cap fix only touched DECLARED
// timeouts: ollama still aborted at exactly 10s, so the provider-default half
// of the bug is the one that mattered.
//
// The cap must stay a CEILING on the member's standalone wait (a stuck member
// may not stall the whole combo), and long-context requests keep their larger
// policy budget.

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { COMBO_CONNECT_TIMEOUT_CAP_MS, FETCH_CONNECT_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");

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

describe("combo connect timeout — the cap applies to the member's standalone wait", () => {
  it("gives a provider that declares no timeout its capped default inside a combo", async () => {
    // ollama's shape: no top-level timeoutMs.
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    expect(delays).toContain(COMBO_CONNECT_TIMEOUT_CAP_MS);
    expect(delays).not.toContain(10000);
  });

  it("gives the same provider its full default outside a combo", async () => {
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds });

    expect(delays).toContain(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("caps a provider that declares more than the combo budget", async () => {
    const ex = new BaseExecutor("slow", { baseUrl: "https://x/api", timeoutMs: 30000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    expect(delays).toContain(COMBO_CONNECT_TIMEOUT_CAP_MS);
    expect(delays).not.toContain(10000);
  });

  it("honours a provider that declares a short timeout (no forced growth)", async () => {
    const ex = new BaseExecutor("quick", { baseUrl: "https://x/api", timeoutMs: 4000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds, isCombo: true });

    expect(delays).toContain(4000);
  });

  it("honours the provider's full declared timeout outside a combo", async () => {
    const ex = new BaseExecutor("slow", { baseUrl: "https://x/api", timeoutMs: 30000 });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds });

    expect(delays).toContain(30000);
  });

  it("still gives long-context requests their larger budget", async () => {
    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(200));
    const { delays } = captureTimeouts();

    await ex.execute({ model: "m", body: longBody, stream: false, credentials: creds, isCombo: true });

    // Policy longWait is >= 180s and must win over the 20s combo cap.
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(180000);
  });
});
