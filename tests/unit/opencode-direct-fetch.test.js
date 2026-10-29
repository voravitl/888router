import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Transport wiring for the OpenCode free lane: a protocol adapter may hand
// proxyAwareFetch its own `directFetch` (the impersonated-TLS client). It must
// carry the direct path, and — when the adapter opts in with directFetchProxy —
// the HTTP-proxy path too, with the proxy URL handed to the adapter. When the
// adapter reports OpencodeTlsUnavailableError the request fails OPEN to native
// fetch and the fallback is logged. wreq-js is never loaded here.

function tlsUnavailable() {
  const err = new Error("wreq-js unavailable (test)");
  err.name = "OpencodeTlsUnavailableError";
  return err;
}

describe("proxyAwareFetch directFetch hook", () => {
  let nativeFetch;
  let savedFetch;
  let savedEnv;
  let proxyAwareFetch;

  beforeEach(async () => {
    savedFetch = globalThis.fetch;
    savedEnv = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) delete process.env[k];
    nativeFetch = vi.fn(async () => new Response("native", { status: 200 }));
    globalThis.fetch = nativeFetch;
    vi.resetModules();
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("uses directFetch on the direct path instead of native fetch", async () => {
    const directFetch = vi.fn(async () => new Response("tls", { status: 200 }));
    const res = await proxyAwareFetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST", body: "{}", directFetch }, null);
    expect(await res.text()).toBe("tls");
    expect(directFetch).toHaveBeenCalledTimes(1);
    const [url, init, extra] = directFetch.mock.calls[0];
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.directFetch).toBeUndefined();
    expect(extra?.proxyUrl ?? null).toBeNull();
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("hands the HTTP connection proxy to directFetch when the adapter opts in", async () => {
    const directFetch = vi.fn(async () => new Response("tls-proxied", { status: 200 }));
    const res = await proxyAwareFetch(
      "https://opencode.ai/zen/v1/chat/completions",
      { method: "POST", body: "{}", directFetch, directFetchProxy: true },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:18080" },
    );
    expect(await res.text()).toBe("tls-proxied");
    expect(directFetch.mock.calls[0][2]).toEqual({ proxyUrl: "http://127.0.0.1:18080" });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("keeps native proxied fetch when the adapter did NOT opt in to proxies", async () => {
    const directFetch = vi.fn(async () => new Response("tls", { status: 200 }));
    await proxyAwareFetch(
      "https://opencode.ai/zen/v1/chat/completions",
      { method: "POST", body: "{}", directFetch },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:18080" },
    );
    expect(directFetch).not.toHaveBeenCalled();
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBeTruthy();
    expect(nativeFetch.mock.calls[0][1].directFetch).toBeUndefined();
  });

  it("fails open to native fetch on OpencodeTlsUnavailableError and logs it (direct)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directFetch = vi.fn(async () => { throw tlsUnavailable(); });
    const res = await proxyAwareFetch("https://opencode.ai/x", { method: "POST", body: "{}", directFetch }, null);
    expect(await res.text()).toBe("native");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][1].directFetch).toBeUndefined();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("OpencodeTlsUnavailableError") || String(c[0]).includes("directFetch unavailable"))).toBe(true);
  });

  it("fails open to native PROXIED fetch on OpencodeTlsUnavailableError (proxy path)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const directFetch = vi.fn(async () => { throw tlsUnavailable(); });
    const res = await proxyAwareFetch(
      "https://opencode.ai/x",
      { method: "POST", body: "{}", directFetch, directFetchProxy: true },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:18080" },
    );
    expect(await res.text()).toBe("native");
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBeTruthy();
  });

  it("propagates any other directFetch error (no silent native retry)", async () => {
    const directFetch = vi.fn(async () => { throw new Error("upstream reset"); });
    await expect(proxyAwareFetch("https://opencode.ai/x", { method: "POST", directFetch }, null)).rejects.toThrow("upstream reset");
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("leaves requests without directFetch byte-identical (native direct fetch)", async () => {
    await proxyAwareFetch("https://example.com/x", { method: "POST", body: "{}" }, null);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const init = nativeFetch.mock.calls[0][1];
    expect(Object.keys(init).sort()).toEqual(["body", "dispatcher", "method"]);
  });
});

describe("BaseExecutor forwards directFetch to proxyAwareFetch", () => {
  it("passes directFetch (+directFetchProxy) through and omits both when absent", async () => {
    vi.resetModules();
    const calls = [];
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({
      proxyAwareFetch: vi.fn(async (url, init, proxyOptions) => {
        calls.push({ url, init, proxyOptions });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    }));
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("testprov", { baseUrl: "https://example.com/v1" });
    const directFetch = vi.fn();

    await ex.execute({ model: "m", body: { a: 1 }, stream: false, credentials: {}, directFetch, directFetchProxy: true });
    await ex.execute({ model: "m", body: { a: 1 }, stream: false, credentials: {} });

    expect(calls[0].init.directFetch).toBe(directFetch);
    expect(calls[0].init.directFetchProxy).toBe(true);
    expect("directFetch" in calls[1].init).toBe(false);
    expect("directFetchProxy" in calls[1].init).toBe(false);
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
  });
});
