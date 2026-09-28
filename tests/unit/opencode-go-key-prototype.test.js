import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

// Regression: chatCore builds requestCredentials via Object.create(credentials),
// putting apiKey on the prototype. prepareRequestCredentials used a bare spread
// (own-enumerable only), dropping the key — buildHeaders fell back to
// "Bearer public" and opencode-go requests failed with upstream 401
// "Missing API key". The executor must materialize the prototype chain.
describe("OpenCodeExecutor.prepareRequestCredentials keeps prototype-inherited key", () => {
  it("carries apiKey from a prototype-linked credentials object", () => {
    const executor = new OpenCodeExecutor("opencode-go");
    const base = { apiKey: "oc_sk_prototype_key", connectionId: "conn-1" };
    const requestCredentials = Object.create(base);
    requestCredentials.rawHeaders = { "user-agent": "opencode/1.0.0" };

    const out = executor.prepareRequestCredentials({
      body: {},
      credentials: requestCredentials,
      providerSessionId: "sess-1",
    });

    expect(out.apiKey).toBe("oc_sk_prototype_key");
    expect(out.connectionId).toBe("conn-1");
    expect(out.rawHeaders).toEqual({ "user-agent": "opencode/1.0.0" });
  });

  it("own properties win over prototype properties, prototype-only fields still visible", () => {
    const executor = new OpenCodeExecutor("opencode-go");
    const base = { apiKey: "base-key", shared: "proto" };
    const requestCredentials = Object.create(base);
    requestCredentials.shared = "own";

    const out = executor.prepareRequestCredentials({ body: {}, credentials: requestCredentials });
    expect(out.shared).toBe("own"); // own shadows prototype
    expect(out.apiKey).toBe("base-key"); // prototype-only field is still carried
  });

  it("buildHeaders sends Bearer apiKey for a Go model (not Bearer public)", () => {
    const executor = new OpenCodeExecutor("opencode-go");
    const base = { apiKey: "oc_sk_live_key" };
    const requestCredentials = Object.create(base);
    const prepared = executor.prepareRequestCredentials({ body: {}, credentials: requestCredentials });

    const headers = executor.buildHeaders(prepared, true, "https://opencode.ai/zen/go/v1/chat/completions", "longcat-2.5-preview-free");
    expect(headers.Authorization).toBe("Bearer oc_sk_live_key");
  });

  it("null credentials stay null-safe", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.prepareRequestCredentials({ body: {}, credentials: null });
    expect(out).toBeTruthy();
  });
});