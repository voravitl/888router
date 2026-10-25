import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 2026-10-25, measured live against the ollama upstream (through the
// gateway's own key):
//
//   connect (TCP+TLS)   : 12 ms
//   headers arrived at  : 5 631 ms
//   first body chunk at : 5 633 ms
//
// The upstream BUFFERS the whole answer and then sends the headers, so
// "time to headers" is "time to first token" and nothing like a connect.
//
// The gateway's `connectTimeoutMs` (10 s) is enforced by an AbortController
// that is cleared only after `proxyAwareFetch` RESOLVES — i.e. it measures
// time to HEADERS, not time to connect. So a healthy provider that takes
// 12 s to think before answering is aborted at 10 s with
// "502 fetch connect timeout" — the same class of false verdict the pool
// park caused, one layer down.
//
// Measured under 6-way concurrency, the same upstream answered at
// 8.0 / 9.4 / 10.6 / 11.5 / 12.5 / 13.9 s — so four of six requests were
// aborted, and the abort was reported as a connect failure.
//
// The fix: the wait for the upstream's RESPONSE HEADERS is a first-byte
// deadline, and it must be the PROVIDER's patience, not a flat 10 s. The
// connect itself is bounded separately by the fetch's own socket timeout.

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { getRequestTimeoutPolicy } = await import("../../open-sse/utils/requestTimeout.js");
const { FETCH_CONNECT_TIMEOUT_MS } = await import("../../open-sse/config/runtimeConfig.js");
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status) {
  return { status, headers: { get: () => "" }, text: async () => "" };
}

// The header-wait timer is the only setTimeout that drives an AbortSignal;
// capture every delay and assert on the set.
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

beforeEach(() => {
  delete process.env.LONG_CONTEXT_TIMEOUT_MS;
  fetchMock.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("the header wait is a first-byte deadline, not a flat 10 s", () => {
  it("gives a normal request more than 10 s to send headers", () => {
    const p = getRequestTimeoutPolicy(smallBody);
    // The measured upstream answers headers in 5.6 s idle and 8–14 s under
    // concurrency; a 10 s budget aborts a healthy provider.
    expect(p.connectTimeoutMs).toBeGreaterThan(15000);
  });

  it("still bounds the wait — it is not unbounded", () => {
    const p = getRequestTimeoutPolicy(smallBody);
    expect(p.connectTimeoutMs).toBeLessThanOrEqual(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("keeps the long-context path as it was", () => {
    const big = { messages: [{ role: "user", content: "x".repeat(400000) }] };
    const p = getRequestTimeoutPolicy(big);
    expect(p.longContext).toBe(true);
    expect(p.connectTimeoutMs).toBeGreaterThanOrEqual(180000);
  });
});

describe("a provider that DECLARES a timeout keeps it", () => {
  it("a declared 30 s is not grown to the 60 s default", async () => {
    fetchMock.mockResolvedValue(res(200));
    const { delays, spy } = captureTimeouts();

    const ex = new BaseExecutor("slow", { baseUrl: "https://x/api", timeoutMs: 30000 });
    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds });
    spy.mockRestore();

    expect(delays).toContain(30000);
    expect(delays).not.toContain(FETCH_CONNECT_TIMEOUT_MS);
  });

  it("a provider that declares none gets the full default", async () => {
    fetchMock.mockResolvedValue(res(200));
    const { delays, spy } = captureTimeouts();

    const ex = new BaseExecutor("ollama", { baseUrl: "https://x/api" });
    await ex.execute({ model: "m", body: smallBody, stream: false, credentials: creds });
    spy.mockRestore();

    expect(delays).toContain(FETCH_CONNECT_TIMEOUT_MS);
  });
});
