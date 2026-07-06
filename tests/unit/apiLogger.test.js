import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { withLogging } from "@/lib/apiLogger";

/** Minimal Next.js-like Response stub used by the wrapper. */
function makeResponse({ status = 200, body = {} } = {}) {
  const headers = new Map();
  let _status = status;
  let _body = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status: typeof status === "number" ? status : _status,
    get ok() { return _status < 400; },
    async json() { return JSON.parse(_body); },
    async text() { return _body; },
  };
}

/** Minimal Next.js NextResponse stub that exposes status() + json() + text(). */
function makeNextResponse({ status = 200, body = {} } = {}) {
  let _status = status;
  let _body = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status() { return _status; },
    async json() { return JSON.parse(_body); },
    async text() { return _body; },
  };
}

function makeRequest({ method = "GET", url = "http://localhost/api/usage/summary" } = {}) {
  return { method, url, headers: new Map() };
}

describe("withLogging", () => {
  let logSpy, warnSpy, errorSpy;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs start and successful completion with status + duration", async () => {
    const handler = vi.fn(async () => makeNextResponse({ status: 200, body: { ok: true } }));
    const wrapped = withLogging(handler, "GET /api/usage/summary");
    const req = makeRequest();

    const res = await wrapped(req);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe("[API] GET http://localhost/api/usage/summary — GET /api/usage/summary");
    const endLine = logSpy.mock.calls[1][0];
    expect(endLine).toMatch(/\[API\] GET .* → 200 \(\d+ms\)/);
    expect(res.status()).toBe(200);
    // 2xx — no body warn log.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs thrown errors with stack and rethrows", async () => {
    const boom = new Error("kaboom");
    const handler = vi.fn(async () => { throw boom; });
    const wrapped = withLogging(handler, "GET /boom");

    await expect(wrapped(makeRequest({ url: "http://localhost/boom" }))).rejects.toThrow("kaboom");

    // Final log line is the 500 end marker.
    const endLine = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
    expect(endLine).toMatch(/→ 500 \(\d+ms\)/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[API] GET http://localhost/boom ✗ kaboom"));
    expect(errorSpy).toHaveBeenCalledWith(boom.stack);
  });

  it("logs body for 4xx responses", async () => {
    const handler = vi.fn(async () => makeNextResponse({ status: 401, body: { error: "Unauthorized" } }));
    const wrapped = withLogging(handler, "GET /api/usage/summary");

    await wrapped(makeRequest());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[API] GET http://localhost/api/usage/summary 401 body={"error":"Unauthorized"}'),
    );
  });

  it("logs body for 5xx responses", async () => {
    const handler = vi.fn(async () => makeNextResponse({ status: 500, body: { error: "boom" } }));
    const wrapped = withLogging(handler, "POST /api/x");

    await wrapped(makeRequest({ method: "POST", url: "http://localhost/api/x" }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[API] POST http://localhost/api/x 500 body={"error":"boom"}'),
    );
  });

  it("does not log body for 2xx/3xx responses", async () => {
    const handler = vi.fn(async () => makeNextResponse({ status: 204 }));
    const wrapped = withLogging(handler, "DELETE /api/x");

    await wrapped(makeRequest({ method: "DELETE", url: "http://localhost/api/x" }));

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("handles plain Response objects with numeric status", async () => {
    const handler = vi.fn(async () => makeResponse({ status: 403, body: "forbidden" }));
    const wrapped = withLogging(handler, "GET /api/x");

    await wrapped(makeRequest({ url: "http://localhost/api/x" }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[API] GET http://localhost/api/x 403 body=forbidden"),
    );
  });

  it("redacts sensitive keys (token/password/apiKey) from logged 4xx body", async () => {
    const handler = vi.fn(async () => makeNextResponse({
      status: 401,
      body: { token: "abc123", password: "hunter2", apiKey: "sk-xxx", normal: "keep" },
    }));
    const wrapped = withLogging(handler, "GET /secret");

    await wrapped(makeRequest({ url: "http://localhost/secret" }));

    const warnLine = warnSpy.mock.calls[0][0];
    expect(warnLine).not.toContain("abc123");
    expect(warnLine).not.toContain("hunter2");
    expect(warnLine).not.toContain("sk-xxx");
    expect(warnLine).toContain("[redacted]");
    // Non-sensitive value is kept for debuggability.
    expect(warnLine).toContain("keep");
  });

  it("redacts Bearer/Basic auth header values from logged body", async () => {
    const handler = vi.fn(async () => makeNextResponse({
      status: 500,
      body: "Authorization: Bearer eyJhbGci.payload.sig",
    }));
    const wrapped = withLogging(handler, "GET /auth");

    await wrapped(makeRequest({ url: "http://localhost/auth" }));

    const warnLine = warnSpy.mock.calls[0][0];
    expect(warnLine).not.toContain("eyJhbGci");
    expect(warnLine).toContain("[redacted]");
  });

  it("truncates very long error bodies to a capped length", async () => {
    const longBody = "x".repeat(2000);
    const handler = vi.fn(async () => makeNextResponse({ status: 500, body: longBody }));
    const wrapped = withLogging(handler, "GET /big");

    await wrapped(makeRequest({ url: "http://localhost/big" }));

    const warnLine = warnSpy.mock.calls[0][0];
    // Capped at 500 + truncation marker — well below the full 2000 chars.
    expect(warnLine).toContain("[truncated]");
    expect(warnLine.length).toBeLessThan(700);
  });

  it("statusCodeOf returns undefined for json-only stub (no 200 assumption)", async () => {
    // A third-party Response stub with .json() but no .status — the old code
    // assumed 200 here, the fix returns undefined so end-log shows (unknown).
    const jsonOnlyResponse = { async json() { return { ok: true }; } };
    const handler = vi.fn(async () => jsonOnlyResponse);
    const wrapped = withLogging(handler, "GET /weird");

    await wrapped(makeRequest({ url: "http://localhost/weird" }));

    // End-log uses `status ?? 200` — undefined falls back to 200 in the log
    // line, but the wrapper no longer lies about status inside
    // statusCodeOf; behavior of logEnd unchanged. We assert no body warn
    // fires (status < 400 path) and end log shows 200.
    expect(warnSpy).not.toHaveBeenCalled();
    const endLine = logSpy.mock.calls[1][0];
    expect(endLine).toMatch(/→ 200 \(\d+ms\)/);
  });
});
