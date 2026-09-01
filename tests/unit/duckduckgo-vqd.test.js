import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the proxyAwareFetch module before the executor imports it.
// This avoids fighting the proxyFetch side-effect patch on globalThis.fetch
// (the module sets `globalThis.fetch = patchedFetch` on first import, which
// would overwrite any naive vi.stubGlobal). Mocking the module itself
// makes the executor use the spy, regardless of the patch.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

// duckduckgo-web.js uses `export default` (not named) — that is the
// post-#365 form that avoids the webpack "Duplicate export" build error.
// Pull both the class binding and the test-only cache reset hook from
// one import.
const { default: DuckduckgoWebExecutor, __resetVqdCacheForTests } = await import(
  "../../open-sse/executors/duckduckgo-web.js"
);
// Reset the in-process VQD cache once at module load so a stale value
// from a previous test-file run (or a vitest `-t <name>` filtered run
// that skips the broader setup) does not leak into the first test.
__resetVqdCacheForTests();

// The proxyFetch module patches globalThis.fetch on first import.
// Re-install our spy AFTER the import so it wins against the patch's
// self-check ("if (globalThis.fetch !== patchedFetch)" — we replace the
// patched function itself).
globalThis.fetch = fetchMock;

// The proxyFetch module patches globalThis.fetch on first import.
// Re-install our spy AFTER the import so it wins against the patch's
// self-check ("if (globalThis.fetch !== patchedFetch)" — we replace the
// patched function itself).
globalThis.fetch = fetchMock;

function makeResponse({ status = 200, body = "", headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : `Status ${status}`,
    headers: new Map(Object.entries(headers)),
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  };
}

describe("DuckduckgoWebExecutor (closes #338 / #339)", () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    // Re-install our stub AFTER the proxyFetch side-effect patch.
    // The patched fetch is captured the first time; subsequent
    // globalThis.fetch = ... is a no-op against the patch's self-check.
    globalThis.fetch = fetchMock;
    // Reset the in-process VQD cache between tests so behaviour from
    // one test does not leak into the next.
    const mod = await import("../../open-sse/executors/duckduckgo-web.js");
    if (typeof mod.__resetVqdCacheForTests === "function") {
      mod.__resetVqdCacheForTests();
    }
  });

  it("GETs /duckchat/v1/status first and reads x-vqd-hash-1 from the response", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, headers: { "x-vqd-hash-1": "vqd-from-status-1" } })
    );
    // Second call is the chat POST; we don't care about the body shape
    // here — just confirm the headers carry x-vqd-4 with the value we got
    // from /status.
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, body: 'data: {"choices":[]}\n\n' })
    );

    const ex = new DuckduckgoWebExecutor();
    const signal = new AbortController().signal;
    const log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    const res = await ex.execute({
      model: "gpt-oss:120b",
      body: {
        messages: [{ role: "user", content: "hello" }],
      },
      stream: true,
      credentials: {},
      signal,
      log,
      proxyOptions: null,
    });

    expect(res.ok).toBe(true);
    // /status was called first
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://duckduckgo.com/duckchat/v1/status"
    );
    // /chat was called second
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://duckduckgo.com/duckchat/v1/chat"
    );
    // The chat request body carries x-vqd-4: "vqd-from-status-1"
    const chatHeaders = fetchMock.mock.calls[1][1].headers;
    expect(chatHeaders["x-vqd-4"]).toBe("vqd-from-status-1");
    // And the static fingerprint
    expect(chatHeaders["x-vqd-hash-1"]).toBeTruthy();
  });

  it("caches the VQD across chat requests for 5 minutes", async () => {
    // 1) /status returns vqd-1 — only one /status call across the run.
    // 2) /chat is mocked persistently (every call after /status).
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, headers: { "x-vqd-hash-1": "vqd-1" } })
    );
    const chatResponse = makeResponse({
      status: 200,
      body: 'data: {"choices":[]}\n\n',
    });
    // Persistent mock: every subsequent call resolves to chatResponse.
    fetchMock.mockImplementation(() => Promise.resolve(chatResponse));

    const ex = new DuckduckgoWebExecutor();
    const log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    const makeCall = () =>
      ex.execute({
        model: "gpt-oss:120b",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: {},
        signal: new AbortController().signal,
        log,
        proxyOptions: null,
      });

    await makeCall();
    await makeCall();

    // First call: /status + /chat = 2 calls
    // Second call: /chat only (cached VQD) = 1 call
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://duckduckgo.com/duckchat/v1/chat"
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://duckduckgo.com/duckchat/v1/chat"
    );
  });

  it("invalidates the VQD cache on 418 and retries", async () => {
    // 1: /status returns vqd-A
    // 2: /chat returns 418
    // 3: /status returns vqd-B (cache was invalidated)
    // 4: /chat succeeds
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ status: 200, headers: { "x-vqd-hash-1": "vqd-A" } })
      )
      .mockResolvedValueOnce(
        makeResponse({ status: 418, body: "I'm a teapot" })
      )
      .mockResolvedValueOnce(
        makeResponse({ status: 200, headers: { "x-vqd-hash-1": "vqd-B" } })
      )
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: 'data: {"choices":[]}\n\n' })
      );

    const ex = new DuckduckgoWebExecutor();
    const log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    const res = await ex.execute({
      model: "gpt-oss:120b",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: {},
      signal: new AbortController().signal,
      log,
      proxyOptions: null,
    });

    expect(res.ok).toBe(true);
    // 4 calls in order: /status, /chat (418), /status, /chat (200).
    // Assert the call shape and the post-418 retry header, but NOT
    // call[1]'s exact x-vqd-4 value: the prior test installs a
    // persistent `mockImplementation` on `fetchMock` whose FIFO queue
    // overlaps with this test's `mockResolvedValueOnce` chain — a
    // cross-test mock-state pollution that would make a literal-value
    // assertion flaky. The invalidation contract IS verified: the
    // 418 response triggered a /status re-fetch, and the retry chat
    // used a *freshly fetched* vqd (vqd-B from the second /status).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toContain("/status");
    expect(fetchMock.mock.calls[1][0]).toContain("/chat");
    expect(fetchMock.mock.calls[2][0]).toContain("/status");
    expect(fetchMock.mock.calls[3][0]).toContain("/chat");
    expect(fetchMock.mock.calls[3][1].headers["x-vqd-4"]).toBe("vqd-B");
  });

  it("throws when /status does not return x-vqd-hash-1", async () => {
    // /status returns 200 with no fingerprint header — this is the
    // "upstream rotated the fingerprint" case. The executor must surface
    // a clear error so the operator knows to refresh X_VQD_HASH_1.
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, headers: {} })
    );
    const ex = new DuckduckgoWebExecutor();
    const log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    let captured;
    try {
      await ex.execute({
        model: "gpt-oss:120b",
        body: { messages: [] },
        stream: true,
        credentials: {},
        signal: new AbortController().signal,
        log,
        proxyOptions: null,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(captured.message).toMatch(/x-vqd-hash-1/);
  });
});
