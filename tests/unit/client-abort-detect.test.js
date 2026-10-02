import { describe, it, expect } from "vitest";

import { isClientAbort } from "../../open-sse/utils/abort.js";
import { formatProviderError } from "../../open-sse/utils/error.js";

// Next.js 16.x aborts request.signal with `new ResponseAborted()` (name
// "ResponseAborted", empty message) when the client disconnects — not with a
// DOMException "AbortError" (node_modules/next/dist/server/web/spec-extension/
// adapters/next-request.js). #517: a bare `error.name === "AbortError"` check
// therefore recorded every client abort as a provider 502 "Unknown error".
class ResponseAborted extends Error {
  constructor(...args) {
    super(...args);
    this.name = "ResponseAborted";
  }
}

describe("isClientAbort", () => {
  it("recognises Next's ResponseAborted (empty message, name != AbortError)", () => {
    const err = new ResponseAborted();
    expect(err.message).toBe("");
    expect(err.name).not.toBe("AbortError");
    expect(isClientAbort(err)).toBe(true);
  });

  it("recognises a DOMException AbortError", () => {
    expect(isClientAbort(new DOMException("The operation was aborted", "AbortError"))).toBe(true);
  });

  it("trusts an aborted signal regardless of how the failure was reported", () => {
    const ac = new AbortController();
    ac.abort(new ResponseAborted());
    // The executor surfaced it as a network error, not as the abort itself.
    expect(isClientAbort(new Error("fetch failed"), ac.signal)).toBe(true);
    expect(isClientAbort(null, ac.signal)).toBe(true);
  });

  it("does not mistake the executor's own connect timeout for a client abort", () => {
    expect(isClientAbort(new Error("fetch connect timeout"))).toBe(false);
    expect(isClientAbort(new Error("fetch connect timeout"), new AbortController().signal)).toBe(false);
  });

  it("is false for ordinary failures and missing input", () => {
    expect(isClientAbort(new Error("boom"))).toBe(false);
    expect(isClientAbort(undefined)).toBe(false);
    expect(isClientAbort(null, null)).toBe(false);
  });
});

describe("formatProviderError with an empty message", () => {
  it("names the error class instead of printing a bare 'Unknown error'", () => {
    const err = new ResponseAborted();
    expect(formatProviderError(err, "opencode", "m", 502)).toBe("[502]: ResponseAborted");
  });

  it("keeps 'Unknown error' when there is nothing better (plain Error, no message)", () => {
    expect(formatProviderError(new Error(), "opencode", "m", 502)).toBe("[502]: Unknown error");
  });

  it("still prefers the real message and appends the low-level cause", () => {
    const err = new Error("fetch failed");
    err.cause = { code: "ECONNRESET", message: "socket hang up" };
    expect(formatProviderError(err, "opencode", "m", 502)).toBe(
      "[502]: fetch failed (cause: ECONNRESET: socket hang up)",
    );
  });
});
