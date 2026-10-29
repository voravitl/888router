import { describe, it, expect, vi, beforeEach } from "vitest";

// The OpenCode free gate keys on the TLS ClientHello: on one process and egress
// IP the same body/headers answered 429 over Node's OpenSSL fingerprint and 200
// over the cipher list below (probe 2026-10-29, receipts #1 vs #2/#4). These
// tests pin the client wiring with wreq-js MOCKED; they never reach the network.
const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

function fakeSession(fetchImpl) {
  return { fetch: vi.fn(fetchImpl || (async () => new Response("ok", { status: 200 }))), close: vi.fn() };
}

describe("opencodeTlsClient", () => {
  beforeEach(() => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  it("creates the session with the verbatim 17-entry cipher list and returns a native Response", async () => {
    const session = fakeSession(async () => new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    createSessionMock.mockResolvedValue(session);

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(loadRuntimeDepMock).toHaveBeenCalledWith("wreq-js");
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const opts = createSessionMock.mock.calls[0][0];
    expect(opts.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    expect(opts.proxy).toBeUndefined();
    const list = __test__.OPENCODE_CIPHER_LIST.split(":");
    expect(list).toHaveLength(17);
    expect(list[0]).toBe("TLS_AES_128_GCM_SHA256");
    expect(list[16]).toBe("AES256-SHA");

    expect(session.fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: ok\n\n");
  });

  it("reuses one direct session across requests", async () => {
    const session = fakeSession();
    createSessionMock.mockResolvedValue(session);
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(session.fetch).toHaveBeenCalledTimes(2);
  });

  // wreq-js 3.2.0 refuses a per-request `proxy` on a session-bound fetch
  // ("Session proxy cannot be changed after creation", dist/wreq-js.js
  // resolveTransportContext). The proxy must be fixed at session creation, so
  // the client keeps one impersonated session per proxy URL.
  it("routes an HTTP proxy through a session created FOR that proxy, never per-request", async () => {
    const direct = fakeSession();
    const proxied = fakeSession();
    createSessionMock.mockImplementation(async (o) => (o.proxy ? proxied : direct));
    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");

    await opencodeTlsFetch("https://opencode.ai/a", { method: "POST" }, { proxyUrl: "http://127.0.0.1:8080" });
    await opencodeTlsFetch("https://opencode.ai/b", { method: "POST" }, { proxyUrl: "http://127.0.0.1:8080" });
    await opencodeTlsFetch("https://opencode.ai/c", { method: "POST" });

    expect(createSessionMock).toHaveBeenCalledTimes(2);
    const proxyCall = createSessionMock.mock.calls.find(([o]) => o.proxy);
    expect(proxyCall[0].proxy).toBe("http://127.0.0.1:8080");
    expect(proxyCall[0].emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    expect(proxied.fetch).toHaveBeenCalledTimes(2);
    expect(direct.fetch).toHaveBeenCalledTimes(1);
    for (const [, init] of proxied.fetch.mock.calls) expect(init.proxy).toBeUndefined();
  });

  it("throws OpencodeTlsUnavailableError when wreq-js cannot be loaded", async () => {
    loadRuntimeDepMock.mockRejectedValue(Object.assign(new Error("Cannot find module 'wreq-js'"), { code: "MODULE_NOT_FOUND" }));
    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import("../../open-sse/services/opencodeTlsClient.js");
    const err = await opencodeTlsFetch("https://opencode.ai/a", {}).catch((e) => e);
    expect(err).toBeInstanceOf(OpencodeTlsUnavailableError);
    expect(err.name).toBe("OpencodeTlsUnavailableError");
  });

  it("does not cache a failed load: the next call retries", async () => {
    loadRuntimeDepMock.mockRejectedValueOnce(new Error("boom"));
    createSessionMock.mockResolvedValue(fakeSession());
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toThrow();
    const res = await opencodeTlsFetch("https://opencode.ai/a", {});
    expect(res.status).toBe(200);
  });

  it("forwards the abort signal to the impersonated request", async () => {
    const session = fakeSession();
    createSessionMock.mockResolvedValue(session);
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const ctrl = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/a", { method: "POST" }, { signal: ctrl.signal });
    expect(session.fetch.mock.calls[0][1].signal).toBe(ctrl.signal);
  });
});

describe("lazyRuntime loader (bundled deps only)", () => {
  it("resolves a package bundled in the app node_modules", async () => {
    vi.doUnmock("../../open-sse/services/lazyRuntime.js");
    vi.resetModules();
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    const undici = await loadRuntimeDep("undici");
    expect(typeof undici.fetch).toBe("function");
  });

  it("rejects a missing package without installing anything", async () => {
    vi.doUnmock("../../open-sse/services/lazyRuntime.js");
    vi.resetModules();
    const { loadRuntimeDep } = await import("../../open-sse/services/lazyRuntime.js");
    await expect(loadRuntimeDep("definitely-not-installed-ocf1029")).rejects.toThrow();
  });
});
